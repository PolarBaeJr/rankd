// A CLUB EVENT SIGN-UP'S YES/NO FORM ANSWERS (00336), as the sign-up list
// shows them. A "yes, this is a resubmission" that replaced no earlier
// response from the same email is flagged: the person most likely signed up
// before under another email, and the desk should look for that sign-up.

export interface SignupFormAnswers {
  resubmission: boolean | null;
  replaced: boolean | null;
  sfuStudent: boolean | null;
}

export function signupAnswerLines(answers: SignupFormAnswers): { flag: string | null; notes: string[] } {
  const notes: string[] = [];
  const flag =
    answers.resubmission === true && answers.replaced !== true
      ? 'Says this is a resubmission: check for an earlier sign-up under another email.'
      : null;
  if (answers.resubmission === true && answers.replaced === true) notes.push('Resubmitted: replaced their earlier response');
  if (answers.sfuStudent === true) notes.push('SFU student: yes');
  if (answers.sfuStudent === false) notes.push('SFU student: no');
  return { flag, notes };
}
