/**
 * Builds the two template Forms the form maker copies (see FORM-MAKER.md).
 *
 * Paste this beside form-maker.gs in the same Apps Script project and run
 * makeTemplates once from the editor. It reads three Script Properties:
 *
 *   FOLDER_NAME      the Drive folder to make (skipped when FOLDER_ID is set)
 *   WAIVER_TEXT      the published participation waiver, as plain text, with
 *                    each line break written as \n (the property box is one
 *                    line)
 *   WAIVER_VERSION   the version that text is
 *
 * and writes FOLDER_ID, TEMPLATE_CLUB_EVENT_ID, TEMPLATE_TOURNAMENT_ID and the
 * two TEMPLATE_..._WAIVER_VERSION properties the form maker reads.
 *
 * ONE STEP IS LEFT BY HAND. Apps Script cannot add a file upload question, so
 * open each template afterwards and add "E-transfer screenshot" (File upload)
 * at the end of the Payment section. The log names both templates.
 *
 * The titles below are the ones the console maps by. Change one here and the
 * console stops finding it.
 */

var TEMPLATE_TITLES_ = {
  name: 'Full name',
  email: 'Email address',
  waiver: 'I have read and agree to the participation waiver above.',
  signature: 'Signature: type your full name to sign the waiver',
  media: 'May the club use photos or video of you from club activities on its website and social media?',
  events: 'Which events are you entering?',
  partners: 'Partners',
  payment: 'Payment',
};

function makeTemplates() {
  var props = PropertiesService.getScriptProperties();
  var waiverText = (props.getProperty('WAIVER_TEXT') || '').replace(/\\n/g, '\n');
  var waiverVersion = props.getProperty('WAIVER_VERSION');
  if (!waiverText || !waiverVersion) {
    throw new Error('Set WAIVER_TEXT and WAIVER_VERSION in Script Properties first.');
  }

  var folder;
  var folderId = props.getProperty('FOLDER_ID');
  if (folderId) {
    folder = DriveApp.getFolderById(folderId);
  } else {
    var folderName = props.getProperty('FOLDER_NAME');
    if (!folderName) throw new Error('Set FOLDER_NAME (or FOLDER_ID) in Script Properties first.');
    folder = DriveApp.createFolder(folderName);
    props.setProperty('FOLDER_ID', folder.getId());
  }

  var club = buildTemplate_('Club event sign-up (template)', false, waiverText, folder);
  var tournament = buildTemplate_('Tournament sign-up (template)', true, waiverText, folder);

  props.setProperty('TEMPLATE_CLUB_EVENT_ID', club.getId());
  props.setProperty('TEMPLATE_CLUB_EVENT_WAIVER_VERSION', waiverVersion);
  props.setProperty('TEMPLATE_TOURNAMENT_ID', tournament.getId());
  props.setProperty('TEMPLATE_TOURNAMENT_WAIVER_VERSION', waiverVersion);

  Logger.log('Club event template: ' + club.getEditUrl());
  Logger.log('Tournament template: ' + tournament.getEditUrl());
  Logger.log('Now add "E-transfer screenshot" (File upload) at the end of the Payment section of each.');
}

function buildTemplate_(title, isTournament, waiverText, folder) {
  var form = FormApp.create(title);
  DriveApp.getFileById(form.getId()).moveTo(folder);
  form.setDescription('');

  form.addTextItem().setTitle(TEMPLATE_TITLES_.name).setRequired(true);
  form.addTextItem().setTitle(TEMPLATE_TITLES_.email).setRequired(true);

  form.addSectionHeaderItem().setTitle('Participation waiver').setHelpText(waiverText);
  form.addCheckboxItem().setTitle(TEMPLATE_TITLES_.waiver).setChoiceValues(['I agree']).setRequired(true);
  form.addTextItem().setTitle(TEMPLATE_TITLES_.signature).setRequired(true);
  form.addMultipleChoiceItem().setTitle(TEMPLATE_TITLES_.media).setChoiceValues(['Allow', 'No']).setRequired(true);

  if (isTournament) {
    form.addCheckboxItem().setTitle(TEMPLATE_TITLES_.events).setChoiceValues(['Placeholder']).setRequired(true);
    form.addPageBreakItem().setTitle(TEMPLATE_TITLES_.partners);
  }

  form.addPageBreakItem().setTitle(TEMPLATE_TITLES_.payment);
  return form;
}
