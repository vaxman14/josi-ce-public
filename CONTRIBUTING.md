# Contributing to Josi CE

Josi CE is in Community Preview. Bug reports, reproducible test cases,
documentation corrections, and focused pull requests are welcome.

## Before opening an issue

1. Search existing issues.
2. Confirm the problem against the current release.
3. Remove credentials, personal data, private hostnames, and diagnostic content
   that may contain user data.
4. For vulnerabilities, follow `SECURITY.md` instead of opening a public issue.

## Pull requests

Keep each pull request focused on one change. Explain the problem, the chosen
approach, and how the change was tested. New behavior should include regression
coverage where practical.

Run the relevant tests and the repository's public-data scanner before pushing:

```bash
npm test
bash scripts/scan-secrets.sh
```

By submitting a contribution, you agree that it is licensed under the same
GNU Affero General Public License terms as the project.
