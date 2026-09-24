// Companion apps.
//
// M101: labelled Coming soon, and with no download or install action, because
// no platform build exists to download. A disabled-looking button would be a
// promise; a sentence is not.
import { Card, CardTitle, NotYet } from '@/components/ui';

export function Apps() {
  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Companion apps</h1>

      <NotYet title="Coming soon">
        There is no iPhone or Android build of Josi yet. When one exists it will be linked here — until
        then there is nothing to install, and this page will not pretend otherwise.
      </NotYet>

      <Card>
        <CardTitle>How signing in will work</CardTitle>
        <p className="text-sm text-muted-foreground">
          You will enter your email address and your normal Josi password. The app asks a small directory
          service which installation owns that address, then sends the password directly to this server over
          HTTPS. The directory never receives your password, your messages, or anything else from this
          installation — only enough to point the app at it. Your administrator has to add your address to
          the approved list first.
        </p>
      </Card>
    </div>
  );
}
