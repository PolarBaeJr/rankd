# The form maker

The console can make an event's Google Form itself. A small Apps Script web
app, `form-maker.gs`, copies a template Form, writes the event's details into
the copy and answers with the new Form's id and links. The console then binds
the Form and reads its responses through the Google Forms API, as it reads a
Form linked by hand. Migration 00296 holds the console's side.

This is set up once, under the club's Google account, by the person who owns
the forms folder. Nothing in this file or in the script holds an id, a link,
an address or a secret: those go in Script Properties and in the console's
environment.

## Before you start

- The console already reads Forms: its service account key is set, and the
  forms folder is shared with that account. The account's email is the
  `READER_EMAIL` below; the Google Form card on an event page shows it.
- Migration 00296 is applied.

## 1. The two templates

Make two Forms in the forms folder. One is copied for club events, the other
for tournaments. The console finds every question by its **title**, so type
these exactly.

Both templates:

| Question | Type |
| --- | --- |
| `Full name` | Short answer, required |
| `Email address` | Short answer, required |
| The participation waiver text | Title and description item |
| `I have read and agree to the participation waiver above.` | Checkbox, required |
| `Signature: type your full name to sign the waiver` | Short answer, required |
| `May the club use photos or video of you from club activities on its website and social media?` | Multiple choice with an `Allow` choice |
| A section titled `Payment` | Section |
| `E-transfer screenshot` (inside `Payment`) | File upload |

The tournament template also has, before the `Payment` section:

| Question | Type |
| --- | --- |
| `Which events are you entering?` | Checkboxes, with one placeholder choice |
| A section titled `Partners` | Section, after the events question |

Leave the `Payment` section's description empty: the console writes the
amount and the e-transfer email there. A free event's copy has the section
removed. Leave the `Partners` section empty: the console adds a
`<event> partner: full name` and a `<event> partner: email` question for each
doubles event.

Write down the version of the waiver the template's text shows (the version
on the published waiver in the console). If the waiver is published again
with new text, update both templates and the two `..._WAIVER_VERSION`
properties below. A Form whose waiver version is not the published one signs
nobody.

## 2. The Apps Script project

Make **two** projects at script.google.com, under the club's account: one for
the club's console and one for staging. Each has its own Script Properties
and its own secret, so staging can never write to the club's Forms. Use a
separate staging folder and staging templates if you can.

In each project:

1. Paste `form-maker.gs` into `Code.gs`.
2. Services (the plus beside Services), add **Drive API**, version **v3**.
   Without it the script still shares each copy, through DriveApp.
3. Project Settings, Script Properties:

   | Property | Value |
   | --- | --- |
   | `SECRET` | the output of `openssl rand -base64 48` |
   | `FOLDER_ID` | the forms folder's id, from its Drive address |
   | `TITLE_PREFIX` | empty on the club's project, `STAGING ` (with the space) on staging |
   | `READER_EMAIL` | the reader service account's email |
   | `TEMPLATE_CLUB_EVENT_ID` | the club event template's id, from its edit address |
   | `TEMPLATE_CLUB_EVENT_WAIVER_VERSION` | the waiver version its text shows |
   | `TEMPLATE_TOURNAMENT_ID` | the tournament template's id |
   | `TEMPLATE_TOURNAMENT_WAIVER_VERSION` | the waiver version its text shows |

4. Deploy, New deployment, type **Web app**. Execute as **Me**, who has access
   **Anyone**. Authorise what it asks for (Forms and Drive). Copy the web app
   address, which ends in `/exec`.

"Anyone" is needed because the console calls it without a Google sign-in.
The secret is what keeps everybody else out: every request without it is
refused before anything is read.

When you change the script, deploy a **new version** of the same deployment
(Manage deployments, edit, Version: New version), so the address stays the
same.

## 3. The console

Set two variables on the admin service, through the deployment dashboard as
`ref:NAME` secrets, never as literal values:

- `GOOGLE_FORM_MAKER_URL`: the web app address from step 2.
- `GOOGLE_FORM_MAKER_SECRET`: the same value as the project's `SECRET`.

The club's console gets the club project's pair, staging gets the staging
project's pair. Restart the service so it reads them.

Then set the e-transfer email under Accounts if it is not set: a paid event's
Form says where to send the money, and the console refuses to make one
without it.

## Using it

On an event or tournament with no Form linked, the Google Form card has
**Make a Google Form**. A new event or tournament gets one on its own when
whoever made it may edit it. The card then shows the Form's links and whether
it is taking responses. Every five minutes, and after each change to the
event, the console brings the Form in step: its title, description, payment
text, event choices, and whether it is open (it closes when the event is
full, closed, started, cancelled or deleted).

A Form linked by hand is never touched, and a tournament run by a club event
gets no Form of its own.

If a free event becomes paid, its copy has no Payment section left: the card
offers **Replace the form**, which closes the old Form and makes a new one.
