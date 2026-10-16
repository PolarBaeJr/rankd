/**
 * Google Form registration import.
 *
 * Posts each response of a Google Form to the Data API's
 * POST /v1/registrations, which enters it into the tournament or club event the
 * form is bound to in the console. Install it in the FORM's script editor
 * (Extensions > Apps Script), not in a linked spreadsheet.
 *
 * SETUP
 *   1. In the console, mint a data API key with the "Import form
 *      registrations" scope (registrations:write), and bind this form's id to
 *      the tournament or club event on that page, against the same consumer.
 *      The form id is printed by running showFormId() below once.
 *   2. Project Settings > Script Properties:
 *        DATA_API_URL   the Data API's base URL, e.g. https://api.example.org
 *        DATA_API_KEY   the key from step 1
 *      Never paste either into this file. The file is safe to share; the
 *      properties are not.
 *   3. Fill in CONFIG below with the form's own question titles and, for each
 *      event choice, the event id from the console.
 *   4. Run installTriggers() once and accept the permissions it asks for.
 *
 * WHAT IT SENDS
 *   The respondent's typed name and email, and one entry per chosen event with
 *   the partner's typed name and email when the event asks for one. The email
 *   is TYPED, not the Google account: a member who signs in to the form with a
 *   personal account still types the address on their club account. A typed
 *   email matching a member never enters them directly; they confirm in the
 *   app.
 *
 * DELIVERY
 *   A response is retried on a rate limit (429), a server error (5xx) or a
 *   network failure, three times with a backoff, and is then parked in a queue
 *   in Script Properties that a ten-minute trigger drains. Sending the same
 *   response twice is safe: the API answers a replay with the first result,
 *   and an EDITED response replaces what the first one entered.
 *
 *   A 400 (the body was refused), 401 (bad key), 403 (scope missing) or 404
 *   (the form is not bound) is not retried; fix the setup and run
 *   resendAll() to send every response again.
 *
 *   Logs carry the response id and the status code only, never a name or an
 *   email.
 *
 * NO SCRIPT AT ALL
 *   The console can instead read the form itself through the Google Forms
 *   API, when it has a service account and the form sits in the folder shared
 *   with that account: "Read this form with Google" on the form's binding,
 *   with the same question titles as CONFIG below. A form is read one way or
 *   the other: while the console reads it, this script's posts for it answer
 *   404 (settled, not retried), so a response is never imported twice at the
 *   same time. Both build the same request from the same answers. Whether
 *   Google gives a response the same id here as through the Forms API is not
 *   confirmed, so moving a form between the script and the console during
 *   registration may import its earlier responses again as new ones; avoid
 *   it, or check the form's imported entries afterwards. For a club event
 *   form, set DEFAULT_EVENT_ID to the event's id (as the console does).
 */

var CONFIG = {
  // Required. The question that asks for the respondent's email.
  EMAIL_QUESTION: 'Email address',
  // Required. The question that asks for the respondent's full name.
  NAME_QUESTION: 'Full name',

  // The question whose choices are the events (a checkbox or multiple choice
  // question). Each choice's text maps to an event id from the console. For a
  // club event form, map the single choice (or leave EVENT_QUESTION empty and
  // set DEFAULT_EVENT_ID to the club event's id).
  EVENT_QUESTION: 'Which events are you entering?',
  EVENTS: {
    "Men's singles": '00000000-0000-0000-0000-000000000001',
    "Mixed doubles": '00000000-0000-0000-0000-000000000002',
  },
  DEFAULT_EVENT_ID: '',

  // Per event choice, the questions that name a partner. Leave an event out
  // for singles.
  PARTNERS: {
    "Mixed doubles": {
      NAME_QUESTION: 'Mixed doubles partner: full name',
      EMAIL_QUESTION: 'Mixed doubles partner: email',
      // Optional: a question whose answer is the team's category.
      CATEGORY_QUESTION: '',
    },
  },
};

var QUEUE_KEY = 'registration_import_queue';
var MAX_QUEUE = 200;
var ATTEMPTS = 3;

function showFormId() {
  Logger.log(FormApp.getActiveForm().getId());
}

function installTriggers() {
  var form = FormApp.getActiveForm();
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    var handler = trigger.getHandlerFunction();
    if (handler === 'onFormSubmit' || handler === 'drainQueue') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('onFormSubmit').forForm(form).onFormSubmit().create();
  ScriptApp.newTrigger('drainQueue').timeBased().everyMinutes(10).create();
}

function onFormSubmit(e) {
  var response = e && e.response ? e.response : null;
  if (!response) return;
  var payload = buildPayload(FormApp.getActiveForm(), response);
  if (!payload) return;
  if (!send(payload)) enqueue(payload.response_id);
}

/** Sends every response again, oldest first. Safe: replays are recognised. */
function resendAll() {
  var form = FormApp.getActiveForm();
  form.getResponses().forEach(function (response) {
    var payload = buildPayload(form, response);
    if (payload && !send(payload)) enqueue(payload.response_id);
  });
}

function drainQueue() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    var form = FormApp.getActiveForm();
    var remaining = [];
    readQueue().forEach(function (responseId) {
      var response;
      try {
        response = form.getResponse(responseId);
      } catch (err) {
        Logger.log('response ' + responseId + ' no longer exists, dropped');
        return;
      }
      var payload = buildPayload(form, response);
      if (payload && !send(payload)) remaining.push(responseId);
    });
    writeQueue(remaining);
  } finally {
    lock.releaseLock();
  }
}

function buildPayload(form, response) {
  var answers = {};
  response.getItemResponses().forEach(function (itemResponse) {
    answers[itemResponse.getItem().getTitle()] = itemResponse.getResponse();
  });
  var email = single(answers[CONFIG.EMAIL_QUESTION]);
  var name = single(answers[CONFIG.NAME_QUESTION]);
  if (!email || !name) {
    Logger.log('response ' + response.getId() + ' has no email or name answer, skipped');
    return null;
  }

  var chosen = answers[CONFIG.EVENT_QUESTION];
  var choices = Array.isArray(chosen) ? chosen : chosen ? [chosen] : [];
  var entries = [];
  choices.forEach(function (choice) {
    var eventId = CONFIG.EVENTS[choice];
    if (!eventId) {
      Logger.log('response ' + response.getId() + ' chose an event with no id in CONFIG.EVENTS');
      return;
    }
    entries.push(entryFor(choice, eventId, answers));
  });
  if (choices.length === 0 && CONFIG.DEFAULT_EVENT_ID) {
    entries.push({ event_id: CONFIG.DEFAULT_EVENT_ID });
  }

  return {
    form_id: form.getId(),
    response_id: response.getId(),
    submitted_at: response.getTimestamp().toISOString(),
    email: email,
    name: name,
    entries: entries,
  };
}

function entryFor(choice, eventId, answers) {
  var entry = { event_id: eventId };
  var partner = CONFIG.PARTNERS[choice];
  if (!partner) return entry;
  var partnerName = single(answers[partner.NAME_QUESTION]);
  var partnerEmail = single(answers[partner.EMAIL_QUESTION]);
  var category = partner.CATEGORY_QUESTION ? single(answers[partner.CATEGORY_QUESTION]) : '';
  if (partnerName) entry.partner_name = partnerName;
  if (partnerEmail) entry.partner_email = partnerEmail;
  if (category) entry.category = category;
  return entry;
}

function single(answer) {
  if (answer === undefined || answer === null) return '';
  var value = Array.isArray(answer) ? answer.join(' ') : String(answer);
  return value.trim();
}

/** True when the response is settled: accepted, or refused for good. */
function send(payload) {
  var properties = PropertiesService.getScriptProperties();
  var base = properties.getProperty('DATA_API_URL');
  var key = properties.getProperty('DATA_API_KEY');
  if (!base || !key) {
    Logger.log('DATA_API_URL or DATA_API_KEY is not set in Script Properties');
    return false;
  }
  var url = base.replace(/\/+$/, '') + '/v1/registrations';
  for (var attempt = 1; attempt <= ATTEMPTS; attempt++) {
    var status = 0;
    try {
      var reply = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + key },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      });
      status = reply.getResponseCode();
    } catch (err) {
      status = 0;
    }
    Logger.log('response ' + payload.response_id + ' attempt ' + attempt + ': HTTP ' + (status || 'network error'));
    if (status >= 200 && status < 300) return true;
    // Refused for a reason a retry cannot fix. resendAll() after the fix.
    if (status === 400 || status === 401 || status === 403 || status === 404 || status === 405 || status === 415) {
      return true;
    }
    if (attempt < ATTEMPTS) Utilities.sleep(1000 * Math.pow(2, attempt));
  }
  return false;
}

function readQueue() {
  var raw = PropertiesService.getScriptProperties().getProperty(QUEUE_KEY);
  if (!raw) return [];
  try {
    var parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function writeQueue(ids) {
  PropertiesService.getScriptProperties().setProperty(QUEUE_KEY, JSON.stringify(ids.slice(-MAX_QUEUE)));
}

function enqueue(responseId) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log('response ' + responseId + ' could not be queued; run resendAll() later');
    return;
  }
  try {
    var queue = readQueue();
    if (queue.indexOf(responseId) === -1) queue.push(responseId);
    writeQueue(queue);
  } finally {
    lock.releaseLock();
  }
}
