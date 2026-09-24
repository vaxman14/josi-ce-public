const DOCS_ROOT = 'https://help.heyjosi.com/';

export const HELP_URL = '/help/index.html';
export const LIVE_HELP_URL = DOCS_ROOT;
export const TERMS_URL = '/help/legal/index.html#terms-of-use';
export const PRIVACY_URL = '/help/legal/index.html#privacy-notice';
export const COOKIES_URL = '/help/legal/index.html#cookie-notice';
export const LICENCE_URL = '/help/legal/index.html#software-and-paid-feature-licences';

export function LegalLinks({ className = '' }: { className?: string }) {
  return (
    <nav aria-label="Legal" className={className}>
      <a href={TERMS_URL} target="_blank" rel="noreferrer noopener">Terms</a>
      <a href={PRIVACY_URL} target="_blank" rel="noreferrer noopener">Privacy</a>
      <a href={COOKIES_URL} target="_blank" rel="noreferrer noopener">Cookies</a>
      <a href={LICENCE_URL} target="_blank" rel="noreferrer noopener">Licences</a>
    </nav>
  );
}
