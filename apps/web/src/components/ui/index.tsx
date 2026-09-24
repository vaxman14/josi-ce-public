// A small set of primitives, written rather than pulled in.
//
// The engine uses shadcn/Radix, which is excellent and is ~15 dependencies.
// CE targets a Raspberry Pi and ships to strangers, so every dependency is
// weight in the image and surface in the supply chain. These cover what the
// nine pages actually use.
//
// The 44px rule lives HERE, in the components, not in each call site: an iOS
// tap target smaller than 44x44 is the accessibility failure the acceptance
// criteria name, and it is not something to remember page by page.
import { useState } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Button({
  variant = 'primary', className, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' }) {
  return (
    <button
      {...props}
      className={cn(
        // min-h-11 is 44px. Not negotiable and not overridable by a caller
        // passing a smaller height, because it comes first in the class list.
        'inline-flex min-h-11 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium',
        'transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-primary text-primary-foreground hover:opacity-90',
        variant === 'secondary' && 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        variant === 'ghost' && 'text-foreground hover:bg-secondary',
        variant === 'danger' && 'bg-destructive text-destructive-foreground hover:opacity-90',
        className,
      )}
    />
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const ignoresPasswordManagers = props.autoComplete === 'off';
  return (
    <input
      {...(ignoresPasswordManagers ? { 'data-1p-ignore': true, 'data-lpignore': 'true', 'data-form-type': 'other' } : {})}
      {...props}
      className={cn(
        // text-base is load-bearing on iOS: anything smaller makes Safari zoom
        // the page when the field takes focus, which reads as a layout bug.
        'min-h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 text-base',
        'placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm',
        className,
      )}
    />
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('min-w-0 rounded-lg border border-border bg-card p-4', className)}>{children}</div>
  );
}

export function CardTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-1 text-base font-semibold tracking-tight">{children}</h2>;
}

/** A compact settings section using the same native disclosure pattern as
 * Connectors. Native details/summary keeps keyboard and screen-reader behavior
 * reliable without adding another client dependency. */
export function CollapsibleCard({
  title,
  summary,
  status,
  defaultOpen = false,
  open,
  onOpenChange,
  children,
  className,
}: {
  title: ReactNode;
  summary?: ReactNode;
  status?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <details open={open ?? (defaultOpen || undefined)} onToggle={event => onOpenChange?.(event.currentTarget.open)} className="group">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <span className="min-w-0">
            <span className="block text-base font-semibold tracking-tight">{title}</span>
            {summary ? <span className="mt-0.5 block text-sm text-muted-foreground">{summary}</span> : null}
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {status}
            <span aria-hidden="true" className="text-muted-foreground transition-transform group-open:rotate-180">⌄</span>
          </span>
        </summary>
        <div className="mt-3 border-t border-border pt-3">{children}</div>
      </details>
    </Card>
  );
}

export function Badge({
  tone = 'muted', children,
}: { tone?: 'muted' | 'primary' | 'danger' | 'ok'; children: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        tone === 'muted' && 'bg-secondary text-secondary-foreground',
        tone === 'primary' && 'bg-primary/20 text-primary',
        tone === 'danger' && 'bg-destructive/20 text-destructive',
        tone === 'ok' && 'bg-emerald-500/20 text-emerald-300',
      )}
    >
      {children}
    </span>
  );
}

/** An honest empty state. Says what would be here and why it is not, which is
 * the difference between "nothing yet" and "something is broken". */
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-6 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children ? <p className="mx-auto mt-1 max-w-prose text-sm text-muted-foreground">{children}</p> : null}
    </div>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <p role="alert" className="text-sm text-destructive">{children}</p>;
}

/** What a feature says when it is genuinely not built yet.
 *
 * Deliberately not a disabled button that looks pressable, and never a date.
 * The acceptance criterion is "no placeholder presented as working", and the
 * e2e suite asserts that pages carrying this contain no enabled action. */
export function NotYet({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-secondary/40 p-4" data-not-built="true">
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-1 text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

/** A value somebody has to paste somewhere else, with a way to take it.
 *
 * LB12.2. The plumbing a person genuinely has to act on — a callback URL, a
 * model identifier, a one-time code — is not hidden; it is put where it can be
 * copied without being retyped. A value shown but not copyable is a value that
 * gets transcribed wrong, and a redirect URL transcribed wrong produces the
 * provider's error page rather than ours.
 */
export function Copyable({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mb-3">
      <label className="mb-1 block text-xs text-muted-foreground">{label}</label>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded bg-secondary px-2 py-1.5 text-xs">{value}</code>
        <Button
          type="button"
          variant="secondary"
          onClick={() => {
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }).catch(() => undefined);
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
}
