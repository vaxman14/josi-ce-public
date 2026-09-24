// Channels: the ways a person reaches Josi that are not the web app.
//
// Telegram is the first. The package boundary exists so that adding a second
// one — Signal, Matrix, whatever — has an obvious shape to copy, and so that
// the rule every channel shares is enforced in one place: an inbound identity
// claim is worthless until a link row, created by a signed-in user, says
// otherwise.
export * from './telegram/api.js';
export * from './telegram/attachments.js';
export * from './telegram/config.js';
export * from './telegram/format.js';
export * from './telegram/inbound.js';
export * from './telegram/linking.js';
export * from './telegram/outbound.js';
export * from './external.js';
export * from './shared.js';
export * from './whatsapp.js';
export * from './slack.js';
export * from './signal.js';
