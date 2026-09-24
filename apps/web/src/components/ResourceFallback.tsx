// The non-ready states of a loaded resource, rendered once, the same way.
//
// Overview and Usage each had their own private version of the Workspace bug:
// swallowing the failure and keying a spinner on `data === null`,
// so a request that failed — including one killed by a poisoned cached
// redirect — rendered as a page loading forever. useResource names every
// outcome; this renders the ones that are not `ready`, so a page only has to
// write its happy path.
import { Button, Card, CardTitle, ErrorNote } from '@/components/ui';
import type { Resource } from '@/lib/useResource';

export function ResourceFallback<T>({ resource }: { resource: Resource<T> }) {
  switch (resource.state) {
    case 'loading':
      return <p className="text-sm text-muted-foreground">Loading…</p>;

    case 'unauthorized':
      return (
        <Card>
          <CardTitle>Not available to you</CardTitle>
          <p className="text-sm text-muted-foreground">{resource.message}</p>
          <Button className="mt-3" onClick={() => { window.location.href = '/login'; }}>
            Go to sign-in
          </Button>
        </Card>
      );

    case 'error':
    case 'timeout':
      return (
        <Card>
          <CardTitle>
            {resource.state === 'timeout' ? 'The server did not answer' : 'This could not be loaded'}
          </CardTitle>
          <ErrorNote>{resource.message}</ErrorNote>
          <Button className="mt-3" onClick={resource.reload}>Try again</Button>
        </Card>
      );

    default:
      return null;
  }
}
