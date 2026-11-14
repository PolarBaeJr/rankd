'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Bug, MessageSquare, ImagePlus, X, Loader2, Check, Lock, Send } from 'lucide-react';
import { PageHeader, Input, Textarea, Button } from '@badminton/ui';
import { createClient } from '@/lib/supabase-browser';
import { submitFeedbackReport, type AppFeedbackKind } from '@/lib/actions/feedback';

// Both mirror 00174's bucket configuration. Checked here as well so an oversized
// or wrong-typed file is refused instantly, next to the picker, instead of after
// an upload that storage was always going to reject.
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 8 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const KINDS: { value: AppFeedbackKind; label: string; hint: string; icon: React.ElementType }[] = [
  { value: 'bug', label: 'Something is broken', hint: 'A page, a button, or a number that looks wrong', icon: Bug },
  { value: 'feedback', label: 'A suggestion', hint: 'An idea, or something that could work better', icon: MessageSquare },
];

export default function FeedbackPage() {
  const [kind, setKind] = useState<AppFeedbackKind>('bug');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [isPending, startTransition] = useTransition();
  const fileInput = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // Preview from the local File, never from storage. The bucket is private and
  // deliberately has no read policy (00174), so there is nothing to read back:
  // and this shows the picture before it is uploaded, which is what you want.
  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    if (!picked) return;
    setError(null);

    if (!ALLOWED_TYPES.includes(picked.type)) {
      setError('Screenshots need to be a JPEG, PNG, or WebP image.');
      return;
    }
    if (picked.size > MAX_BYTES) {
      setError('That image is over 8 MB. Try a screenshot of just the part that went wrong.');
      return;
    }
    setFile(picked);
  }

  function clearFile() {
    setFile(null);
    if (fileInput.current) fileInput.current.value = '';
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    startTransition(async () => {
      try {
        let imagePath: string | null = null;

        // Uploaded from the browser, exactly like an avatar: the file never
        // passes through the server action, which keeps a multi-megabyte body
        // off the Node process that renders every other page. The path is
        // folder-per-user because that is what storage RLS enforces on, and the
        // action re-checks it because a path is client-supplied either way.
        if (file) {
          const supabase = createClient();
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) {
            setError('Your session expired. Sign in again and resend.');
            return;
          }

          const path = `${user.id}/${crypto.randomUUID()}.${EXTENSIONS[file.type] ?? 'jpg'}`;
          const { error: uploadError } = await supabase.storage
            .from('feedback-screenshots')
            .upload(path, file, { contentType: file.type, upsert: false });

          // The report is the words; the screenshot is a bonus. A failed upload
          // must not eat what they typed, so it is reported and the send stops
          // here rather than silently filing a report with no picture. They can
          // remove the image and send again.
          if (uploadError) {
            setError(`The screenshot could not be uploaded (${uploadError.message}). Remove it and send again, or try a smaller image.`);
            return;
          }
          imagePath = path;
        }

        const res = await submitFeedbackReport({ kind, title, body, imagePath });
        if (!res.ok) {
          setError(res.error);
          return;
        }

        setSent(true);
        setTitle('');
        setBody('');
        clearFile();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not send that report');
      }
    });
  }

  const titleCount = title.length;
  const bodyCount = body.length;

  if (sent) {
    return (
      <div className="page" style={{ maxWidth: 720 }}>
        <PageHeader eyebrow="Feedback" title="Thanks" />
        <div
          className="card-base"
          style={{ padding: '36px 24px', display: 'grid', gap: 14, justifyItems: 'center', textAlign: 'center' }}
        >
          <span
            aria-hidden
            style={{
              width: 56,
              height: 56,
              borderRadius: '50%',
              display: 'grid',
              placeItems: 'center',
              background: 'var(--red-wash)',
              border: '1px solid var(--red-border)',
              color: 'var(--red)',
            }}
          >
            <Check size={26} />
          </span>
          <div style={{ fontFamily: 'var(--display)', fontSize: 22, fontWeight: 700 }}>
            That went straight to the exec team.
          </div>
          <p className="muted" style={{ fontSize: 14, margin: 0, maxWidth: 420 }}>
            There is no reply thread here. If they need more detail, someone will get in touch.
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center', marginTop: 6 }}>
            <Button type="button" variant="secondary" onClick={() => setSent(false)}>Send another</Button>
            <Button type="button" onClick={() => router.push('/feed')}>Back to the feed</Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    // 720 is a reading measure, the same reason Settings narrows itself: a
    // form stretched across a desktop puts the label a long way from its box.
    <div className="page" style={{ maxWidth: 720 }}>
      <PageHeader
        eyebrow="Feedback"
        title="Report a problem"
        sub="Something broken, or an idea that would make the app better. Every report is read."
      />

      <form onSubmit={submit} style={{ display: 'grid', gap: 16 }}>
        {/* A radio group, not two buttons: exactly one is always chosen. The
            chosen tile is marked in red because --accent is a grey surface in
            this theme, and a grey border on a grey card read as nothing. */}
        <div
          role="radiogroup"
          aria-label="What kind of report"
          style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}
        >
          {KINDS.map((k) => {
            const Icon = k.icon;
            const active = kind === k.value;
            return (
              <button
                key={k.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => setKind(k.value)}
                className="card-base"
                style={{
                  padding: 16,
                  display: 'flex',
                  gap: 14,
                  alignItems: 'flex-start',
                  textAlign: 'left',
                  cursor: 'pointer',
                  borderColor: active ? 'var(--red)' : undefined,
                  background: active ? 'var(--red-wash)' : undefined,
                  transition: 'border-color .15s, background .15s',
                }}
              >
                <span
                  aria-hidden
                  style={{
                    width: 36,
                    height: 36,
                    flexShrink: 0,
                    borderRadius: 'var(--r-md)',
                    display: 'grid',
                    placeItems: 'center',
                    background: active ? 'var(--red)' : 'var(--surface-2)',
                    color: active ? '#fff' : 'var(--mute)',
                    transition: 'background .15s, color .15s',
                  }}
                >
                  <Icon size={18} />
                </span>
                <span style={{ display: 'grid', gap: 2 }}>
                  <span style={{ fontWeight: 600, fontSize: 15 }}>{k.label}</span>
                  <span className="muted" style={{ fontSize: 13, lineHeight: 1.4 }}>{k.hint}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="card-base" style={{ padding: 20, display: 'grid', gap: 18 }}>
          <div style={{ display: 'grid', gap: 4 }}>
            <Input
              label="Summary"
              value={title}
              maxLength={120}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={kind === 'bug' ? 'Check-in button does nothing' : 'Show court numbers on the schedule'}
            />
            <span className="muted" style={{ fontSize: 11, justifySelf: 'end', fontFamily: 'var(--mono)' }}>
              {titleCount} / 120
            </span>
          </div>

          <div style={{ display: 'grid', gap: 4 }}>
            <Textarea
              label={kind === 'bug' ? 'What happened?' : 'What is your idea?'}
              value={body}
              rows={7}
              maxLength={4000}
              required
              onChange={(e) => setBody(e.target.value)}
              placeholder={
                kind === 'bug'
                  ? 'What you were doing, what you expected, and what happened instead.'
                  : 'What would you change, and what would it make easier?'
              }
            />
            <span className="muted" style={{ fontSize: 11, justifySelf: 'end', fontFamily: 'var(--mono)' }}>
              {bodyCount} / 4000
            </span>
          </div>

          <div style={{ display: 'grid', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-secondary)' }}>
              Screenshot <span className="muted">(optional)</span>
            </span>
            <input
              ref={fileInput}
              type="file"
              accept={ALLOWED_TYPES.join(',')}
              onChange={pick}
              style={{ display: 'none' }}
            />

            {preview ? (
              <div style={{ position: 'relative', justifySelf: 'start', maxWidth: '100%' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={preview}
                  alt="Screenshot to be attached"
                  style={{
                    display: 'block',
                    maxWidth: '100%',
                    maxHeight: 280,
                    borderRadius: 'var(--r-md)',
                    border: '1px solid var(--border)',
                  }}
                />
                <button
                  type="button"
                  onClick={clearFile}
                  aria-label="Remove screenshot"
                  style={{
                    position: 'absolute',
                    top: 8,
                    right: 8,
                    width: 30,
                    height: 30,
                    borderRadius: '50%',
                    display: 'grid',
                    placeItems: 'center',
                    background: 'rgba(0, 0, 0, 0.7)',
                    color: '#fff',
                    border: 0,
                    cursor: 'pointer',
                  }}
                >
                  <X size={16} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                style={{
                  display: 'grid',
                  justifyItems: 'center',
                  gap: 6,
                  padding: '22px 16px',
                  borderRadius: 'var(--r-md)',
                  border: '1.5px dashed var(--line-2)',
                  background: 'transparent',
                  color: 'inherit',
                  cursor: 'pointer',
                }}
              >
                <ImagePlus size={22} style={{ color: 'var(--mute)' }} />
                <span style={{ fontSize: 14, fontWeight: 600 }}>Add a screenshot</span>
                <span className="muted" style={{ fontSize: 12 }}>JPEG, PNG, or WebP, up to 8 MB</span>
              </button>
            )}
          </div>

          {error && (
            <p
              role="alert"
              style={{
                fontSize: 13,
                margin: 0,
                padding: '10px 12px',
                borderRadius: 'var(--r-md)',
                color: 'var(--red)',
                background: 'var(--red-wash)',
                border: '1px solid var(--red-border)',
              }}
            >
              {error}
            </p>
          )}

          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 14,
              alignItems: 'center',
              justifyContent: 'space-between',
              borderTop: '1px solid var(--border)',
              paddingTop: 16,
            }}
          >
            {/* Same disclosure the tournament survey makes, for the same reason:
                a member must never be surprised to find their words in Discord.
                The relay only runs where the report channel is set, so "may". */}
            <p className="muted" style={{ fontSize: 12, margin: 0, flex: '1 1 260px', display: 'flex', gap: 8, lineHeight: 1.45 }}>
              <Lock size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>
                Sent to the exec team with your name, so they can follow up. A copy may also go to
                their private Discord channel. Screenshots are only visible to them.
              </span>
            </p>
            <Button type="submit" disabled={isPending || !body.trim()} style={{ flex: '0 0 auto' }}>
              {isPending ? (
                <><Loader2 size={16} className="animate-spin" /> Sending</>
              ) : (
                <><Send size={15} /> {kind === 'bug' ? 'Send bug report' : 'Send suggestion'}</>
              )}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
