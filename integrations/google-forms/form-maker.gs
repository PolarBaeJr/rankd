/**
 * Google Form maker.
 *
 * A web app the console calls to make and update the club's sign-up Forms
 * (migration 00296). It copies one of two template Forms into the forms
 * folder, writes the event's title, description, payment text and (for a
 * tournament) the event choices and partner questions, shares the copy with
 * the console's reader service account, and answers with the new Form's id
 * and links. The console then reads the Form's responses itself.
 *
 * Install it as its OWN Apps Script project (script.google.com, New project),
 * not inside a Form. The full setup is in FORM-MAKER.md next to this file.
 *
 * SCRIPT PROPERTIES (Project Settings > Script Properties). Never paste any of
 * them into this file; the file is safe to share, the properties are not.
 *   SECRET                              the shared secret the console sends
 *   FOLDER_ID                           the Drive folder the copies go in
 *   TITLE_PREFIX                        put before every title ('' on the club's
 *                                       own deployment, 'STAGING ' on staging)
 *   READER_EMAIL                        the reader service account's email
 *   SHARE_EVERY_FORM                    'yes' on the club's own deployment only:
 *                                       shareEveryForm shares every Form the
 *                                       account owns, not just the ones made here
 *   TEMPLATE_CLUB_EVENT_ID              the club event template Form
 *   TEMPLATE_CLUB_EVENT_WAIVER_VERSION  the waiver version its text shows
 *   TEMPLATE_TOURNAMENT_ID              the tournament template Form
 *   TEMPLATE_TOURNAMENT_WAIVER_VERSION  the waiver version its text shows
 *
 * THE TEMPLATES. Every question the console reads is found by its TITLE, so
 * the titles below must be exactly as written. Both templates carry the club
 * participation waiver with its "I agree", signature and photo questions, and
 * a section titled "Payment" holding the "E-transfer screenshot" upload.
 * The tournament template also has a checkbox question "Which events are you
 * entering?" and a section titled "Partners" after it.
 *
 * REQUESTS. One JSON body per POST, with the secret and an action:
 *   create  {requestKey, template, title, description, payment, choices,
 *            accepting, closedMessage}
 *   update  {formId, title, description, payment, choices}
 *   close   {formId, closedMessage}
 *   open    {formId}
 * payment is {text} or null (a free event: the Payment section is removed).
 * choices is [{label, doubles}] for a tournament, null for a club event.
 *
 * A create with a requestKey already seen answers with the Form it made then,
 * rewritten with the new content, so the console may retry safely. update,
 * close and open refuse a Form this script did not make.
 *
 * ANSWERS. Always JSON. {ok: true, ...} or {ok: false, code}, where code is
 * one of: unauthorized, bad_request, template_missing, folder_missing,
 * form_unknown, payment_section_missing, question_missing, google_refused.
 * Nothing is logged: the body carries the secret.
 */

var PAYMENT_SECTION = 'Payment';
var RECEIPT_QUESTION = 'E-transfer screenshot';
var EVENTS_QUESTION = 'Which events are you entering?';
var PARTNER_SECTION = 'Partners';
var PARTNER_NAME_SUFFIX = ' partner: full name';
var PARTNER_EMAIL_SUFFIX = ' partner: email';

function MakerError(code) {
  this.code = code;
}

function answer(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}

function digest(text) {
  return Utilities.base64Encode(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8)
  );
}

function property(name) {
  var value = PropertiesService.getScriptProperties().getProperty(name);
  return value === null ? '' : value;
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  var locked = false;
  try {
    var body;
    try {
      body = JSON.parse(e && e.postData ? e.postData.contents : '');
    } catch (parseError) {
      return answer({ ok: false, code: 'bad_request' });
    }
    if (!body || typeof body !== 'object') return answer({ ok: false, code: 'bad_request' });

    // Compared as digests, so the comparison does not depend on where the
    // two strings first differ.
    var secret = property('SECRET');
    if (!secret || typeof body.secret !== 'string' || digest(body.secret) !== digest(secret)) {
      return answer({ ok: false, code: 'unauthorized' });
    }

    locked = lock.tryLock(30000);
    if (!locked) return answer({ ok: false, code: 'google_refused' });

    if (body.action === 'create') return answer(create(body));
    if (body.action === 'update') return answer(update(body));
    if (body.action === 'close') return answer(setAccepting(body, false));
    if (body.action === 'open') return answer(setAccepting(body, true));
    return answer({ ok: false, code: 'bad_request' });
  } catch (err) {
    // Never the exception's message: it can quote the request.
    return answer({ ok: false, code: err instanceof MakerError ? err.code : 'google_refused' });
  } finally {
    if (locked) lock.releaseLock();
  }
}

function text(value, max) {
  if (typeof value !== 'string') throw new MakerError('bad_request');
  if (value.length > max) throw new MakerError('bad_request');
  return value;
}

function checkPayment(payment) {
  if (payment === null || payment === undefined) return null;
  if (typeof payment !== 'object') throw new MakerError('bad_request');
  return { text: text(payment.text, 4000) };
}

function checkChoices(choices) {
  if (choices === null || choices === undefined) return null;
  if (!Array.isArray(choices) || choices.length > 40) throw new MakerError('bad_request');
  return choices.map(function (choice) {
    if (!choice || typeof choice !== 'object') throw new MakerError('bad_request');
    return { label: text(choice.label, 300), doubles: choice.doubles === true };
  });
}

function templateFor(kind) {
  if (kind === 'club_event') {
    return { id: property('TEMPLATE_CLUB_EVENT_ID'), waiverVersion: property('TEMPLATE_CLUB_EVENT_WAIVER_VERSION') };
  }
  if (kind === 'tournament') {
    return { id: property('TEMPLATE_TOURNAMENT_ID'), waiverVersion: property('TEMPLATE_TOURNAMENT_WAIVER_VERSION') };
  }
  throw new MakerError('bad_request');
}

function openMade(formId) {
  if (typeof formId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(formId)) throw new MakerError('bad_request');
  if (property('made:' + formId) !== '1') throw new MakerError('form_unknown');
  try {
    return FormApp.openById(formId);
  } catch (err) {
    throw new MakerError('form_unknown');
  }
}

function create(body) {
  var requestKey = text(body.requestKey, 200);
  var template = templateFor(body.template);
  var title = text(body.title, 300);
  var description = text(body.description, 4000);
  var payment = checkPayment(body.payment);
  var choices = checkChoices(body.choices);
  var closedMessage = text(body.closedMessage, 500);
  if (typeof body.accepting !== 'boolean') throw new MakerError('bad_request');
  if (body.template === 'tournament' && !choices) throw new MakerError('bad_request');

  var props = PropertiesService.getScriptProperties();
  var form = null;
  var existing = props.getProperty('req:' + requestKey);
  if (existing) {
    try {
      form = FormApp.openById(existing);
    } catch (err) {
      form = null;
    }
  }

  if (!form) {
    var templateFile;
    try {
      templateFile = DriveApp.getFileById(template.id);
    } catch (err) {
      throw new MakerError('template_missing');
    }
    var folder;
    try {
      folder = DriveApp.getFolderById(property('FOLDER_ID'));
    } catch (err) {
      throw new MakerError('folder_missing');
    }
    var copy = templateFile.makeCopy(property('TITLE_PREFIX') + title, folder);
    form = FormApp.openById(copy.getId());
    // Recorded before anything else can fail, so a retry finds this copy.
    props.setProperty('req:' + requestKey, form.getId());
    props.setProperty('made:' + form.getId(), '1');
    shareWithReader(form.getId());
  }

  writeContent(form, title, description, payment, choices);
  if (typeof form.setPublished === 'function') form.setPublished(true);
  form.setCustomClosedFormMessage(closedMessage);
  form.setAcceptingResponses(body.accepting);

  return {
    ok: true,
    formId: form.getId(),
    responderUrl: form.getPublishedUrl(),
    editUrl: form.getEditUrl(),
    accepting: form.isAcceptingResponses(),
    waiverVersion: template.waiverVersion,
  };
}

function update(body) {
  var form = openMade(body.formId);
  writeContent(
    form,
    text(body.title, 300),
    text(body.description, 4000),
    checkPayment(body.payment),
    checkChoices(body.choices)
  );
  return { ok: true };
}

function setAccepting(body, on) {
  var form = openMade(body.formId);
  if (!on) form.setCustomClosedFormMessage(text(body.closedMessage, 500));
  form.setAcceptingResponses(on);
  return { ok: true, accepting: form.isAcceptingResponses() };
}

/**
 * Editor on the copy for the reader service account: Google shows a Form's
 * responses only to its editors. Drive advanced service v3, so nobody is
 * sent a sharing email; DriveApp when the service is not switched on.
 */
function shareWithReader(fileId) {
  var reader = property('READER_EMAIL');
  if (!reader) return;
  try {
    Drive.Permissions.create({ role: 'writer', type: 'user', emailAddress: reader }, fileId, {
      sendNotificationEmail: false,
      supportsAllDrives: true,
    });
  } catch (err) {
    DriveApp.getFileById(fileId).addEditor(reader);
  }
}

/**
 * A Form made by hand needs the reader too, and sharing each one is a chore.
 * Run installShareEveryForm once from the editor: every ten minutes after that,
 * every Form this account owns that the reader cannot see yet is shared with
 * it. Staging's project leaves SHARE_EVERY_FORM unset, so its reader never
 * gains the club's Forms.
 */
function shareEveryForm() {
  if (property('SHARE_EVERY_FORM') !== 'yes') return;
  var reader = property('READER_EMAIL').toLowerCase();
  if (!reader) return;
  var me = Session.getEffectiveUser().getEmail().toLowerCase();
  var forms = DriveApp.getFilesByType(MimeType.GOOGLE_FORMS);
  while (forms.hasNext()) {
    var file = forms.next();
    if (file.isTrashed()) continue;
    var owner = file.getOwner();
    if (!owner || owner.getEmail().toLowerCase() !== me) continue;
    var shared = file.getEditors().some(function (user) {
      return user.getEmail().toLowerCase() === reader;
    });
    if (!shared) shareWithReader(file.getId());
  }
}

function installShareEveryForm() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'shareEveryForm') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('shareEveryForm').timeBased().everyMinutes(10).create();
  shareEveryForm();
}

function writeContent(form, title, description, payment, choices) {
  form.setTitle(property('TITLE_PREFIX') + title);
  form.setDescription(description);
  applyPayment(form, payment);
  if (choices) applyChoices(form, choices);
}

function pageBreakIndex(form, sectionTitle) {
  var items = form.getItems();
  for (var i = 0; i < items.length; i++) {
    if (items[i].getType() === FormApp.ItemType.PAGE_BREAK && items[i].getTitle() === sectionTitle) return i;
  }
  return -1;
}

/** The index of the next page break after `from`, or the item count. */
function sectionEnd(form, from) {
  var items = form.getItems();
  for (var i = from + 1; i < items.length; i++) {
    if (items[i].getType() === FormApp.ItemType.PAGE_BREAK) return i;
  }
  return items.length;
}

/**
 * A paid event: the Payment section's description is the payment text, and
 * it must still hold the screenshot upload. A free one: the section and
 * everything in it is removed, so nobody is asked to pay.
 */
function applyPayment(form, payment) {
  var start = pageBreakIndex(form, PAYMENT_SECTION);
  if (!payment) {
    if (start < 0) return;
    var end = sectionEnd(form, start);
    for (var i = end - 1; i >= start; i--) form.deleteItem(i);
    return;
  }
  if (start < 0) throw new MakerError('payment_section_missing');
  var items = form.getItems();
  var stop = sectionEnd(form, start);
  var hasReceipt = false;
  for (var j = start + 1; j < stop; j++) {
    if (items[j].getTitle() === RECEIPT_QUESTION) hasReceipt = true;
  }
  if (!hasReceipt) throw new MakerError('payment_section_missing');
  items[start].asPageBreakItem().setHelpText(payment.text);
}

/**
 * A tournament: the events question's choices are the events, and the
 * Partners section has a name and an email question for each doubles choice,
 * neither required. Partner questions for a choice that is gone are removed.
 */
function applyChoices(form, choices) {
  var items = form.getItems();
  var events = null;
  for (var i = 0; i < items.length; i++) {
    if (items[i].getType() === FormApp.ItemType.CHECKBOX && items[i].getTitle() === EVENTS_QUESTION) {
      events = items[i].asCheckboxItem();
    }
  }
  if (!events) throw new MakerError('question_missing');
  if (choices.length > 0) {
    events.setChoiceValues(
      choices.map(function (choice) {
        return choice.label;
      })
    );
  }

  var wanted = {};
  choices.forEach(function (choice) {
    if (choice.doubles) {
      wanted[choice.label + PARTNER_NAME_SUFFIX] = true;
      wanted[choice.label + PARTNER_EMAIL_SUFFIX] = true;
    }
  });
  var start = pageBreakIndex(form, PARTNER_SECTION);
  if (start < 0) {
    if (Object.keys(wanted).length > 0) throw new MakerError('question_missing');
    return;
  }

  // Stale partner questions go first, from the end so indexes hold.
  var end = sectionEnd(form, start);
  items = form.getItems();
  var present = {};
  for (var k = end - 1; k > start; k--) {
    var itemTitle = items[k].getTitle();
    var isPartner = itemTitle.slice(-PARTNER_NAME_SUFFIX.length) === PARTNER_NAME_SUFFIX ||
      itemTitle.slice(-PARTNER_EMAIL_SUFFIX.length) === PARTNER_EMAIL_SUFFIX;
    if (!isPartner || items[k].getType() !== FormApp.ItemType.TEXT) continue;
    if (wanted[itemTitle]) {
      present[itemTitle] = true;
    } else {
      form.deleteItem(k);
    }
  }

  choices.forEach(function (choice) {
    if (!choice.doubles) return;
    [choice.label + PARTNER_NAME_SUFFIX, choice.label + PARTNER_EMAIL_SUFFIX].forEach(function (questionTitle) {
      if (present[questionTitle]) return;
      // Into the Partners section, at its end. A new item is added last, so it
      // only moves when a later section follows.
      var target = sectionEnd(form, pageBreakIndex(form, PARTNER_SECTION));
      var added = form.addTextItem().setTitle(questionTitle).setRequired(false);
      if (added.getIndex() > target) form.moveItem(added.getIndex(), target);
      present[questionTitle] = true;
    });
  });
}
