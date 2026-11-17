import { describe, it, expect } from 'vitest';
import { signupAnswerLines } from '../signup-form-answers';

describe('a sign-up\'s resubmission and student answers (00336)', () => {
  const FLAG = 'Says this is a resubmission: check for an earlier sign-up under another email.';

  it('flags a resubmission that replaced nothing', () => {
    expect(signupAnswerLines({ resubmission: true, replaced: false, sfuStudent: null })).toEqual({ flag: FLAG, notes: [] });
    expect(signupAnswerLines({ resubmission: true, replaced: null, sfuStudent: null }).flag).toBe(FLAG);
  });

  it('notes a resubmission that replaced the earlier response, without flagging it', () => {
    expect(signupAnswerLines({ resubmission: true, replaced: true, sfuStudent: null })).toEqual({
      flag: null,
      notes: ['Resubmitted: replaced their earlier response'],
    });
  });

  it('says nothing about a first submission or an unanswered question', () => {
    expect(signupAnswerLines({ resubmission: false, replaced: false, sfuStudent: null })).toEqual({ flag: null, notes: [] });
    expect(signupAnswerLines({ resubmission: null, replaced: null, sfuStudent: null })).toEqual({ flag: null, notes: [] });
  });

  it('shows the student answer either way', () => {
    expect(signupAnswerLines({ resubmission: null, replaced: null, sfuStudent: true }).notes).toEqual(['SFU student: yes']);
    expect(signupAnswerLines({ resubmission: null, replaced: null, sfuStudent: false }).notes).toEqual(['SFU student: no']);
  });
});
