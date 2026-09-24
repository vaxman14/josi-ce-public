import type { NextFunction, Request, Response } from 'express';

/** Express 5 forwards a rejected promise to the error handler on its own, but
 * being explicit keeps the intent legible and works identically if the router
 * is ever mounted on an older stack. */
export function asyncRoute(
  fn: (req: Request, res: Response) => Promise<unknown>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/** Express 5 types a route param as `string | string[]` because a pattern can
 * repeat. Ours never do, so this narrows once instead of casting at every call
 * site — and an array (which would mean a duplicated param in a crafted URL)
 * collapses to the empty string rather than being silently joined. */
export function param(req: Request, name: string): string {
  const value = req.params[name];
  return typeof value === 'string' ? value : '';
}
