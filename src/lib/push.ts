import { readFileSync } from 'node:fs';
import admin from 'firebase-admin';

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * §15 NOTIFICATIONS — Firebase Cloud Messaging.
 *
 * FCM reaches Android directly and iOS through APNs (upload the APNs auth key
 * to the Firebase project once, and Firebase forwards for every app in it).
 * Every white-label shop app is a separate app inside ONE Firebase project, so
 * a single service account here covers all of them and nothing about this file
 * changes when a shop is added.
 *
 * Replaces the Expo Push transport: the customer app now registers a native
 * FCM token, which the Expo endpoint cannot accept.
 */

/**
 * Must match the channel the app creates (src/hooks/usePushRegistration.ts).
 * A channelId Android does not know falls back to a DEFAULT-importance
 * channel, which is exactly the silent-in-the-shade behaviour this avoids.
 */
export const ANDROID_CHANNEL_ID = 'orders';

export type PushMessage = {
  token: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
};

/** What the caller must do about each token afterwards. */
export type PushResult = {
  sent: number;
  /**
   * Tokens FCM says are dead — the app was uninstalled, or the token was
   * rotated. They will NEVER work again, so the caller prunes them; leaving
   * them on the user grows an unbounded list of tokens that fail on every
   * order for the life of the account.
   */
  invalidTokens: string[];
};

let app: admin.app.App | null = null;
let initFailed = false;

/**
 * Resolved lazily rather than at import time so the server still boots — and
 * every non-push feature still works — on a machine with no Firebase
 * credentials, which is every developer's machine.
 */
function getApp(): admin.app.App | null {
  if (app || initFailed) return app;

  try {
    let credential: admin.credential.Credential | null = null;

    if (env.FIREBASE_SERVICE_ACCOUNT) {
      const raw = env.FIREBASE_SERVICE_ACCOUNT.trim();
      // Accept the raw JSON or a base64 blob of it: several hosts mangle
      // multi-line values, and the private key in this file is multi-line.
      const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
      credential = admin.credential.cert(JSON.parse(json) as admin.ServiceAccount);
    } else if (env.GOOGLE_APPLICATION_CREDENTIALS) {
      credential = admin.credential.cert(
        JSON.parse(readFileSync(env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8')) as admin.ServiceAccount,
      );
    }

    if (!credential) return null;
    app = admin.initializeApp({ credential });
    logger.info('Firebase Cloud Messaging ready');
    return app;
  } catch (err) {
    // Once, not per notification — a malformed key would otherwise log on
    // every single order event for as long as the process lives.
    initFailed = true;
    logger.error({ err }, 'Firebase credentials are present but unusable — push is disabled');
    return null;
  }
}

/** True when a real credential is configured, so callers can branch in tests. */
export function isPushConfigured(): boolean {
  return getApp() !== null;
}

const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

export async function sendPush(messages: PushMessage[]): Promise<PushResult> {
  const empty: PushResult = { sent: 0, invalidTokens: [] };
  if (messages.length === 0) return empty;

  const fb = getApp();
  if (!fb) {
    logger.info(
      { count: messages.length, titles: messages.map((m) => m.title) },
      '[dev] push not sent (no Firebase credentials configured)',
    );
    return empty;
  }

  try {
    const response = await fb.messaging().sendEach(
      messages.map((m) => ({
        token: m.token,
        notification: { title: m.title, body: m.body },
        // FCM data values must be strings — anything else is rejected for the
        // whole message, so objects are serialised rather than dropped.
        data: Object.fromEntries(
          Object.entries(m.data ?? {}).map(([k, v]) => [
            k,
            typeof v === 'string' ? v : JSON.stringify(v),
          ]),
        ),
        /**
         * `priority: high` wakes a dozing device instead of holding the
         * message until the next maintenance window — an order update is
         * time-critical, and Doze can otherwise delay it by many minutes.
         *
         * `channelId` targets a channel the app creates at HIGH importance, so
         * the notification pops as a banner over whatever the customer is
         * doing rather than only landing silently in the shade. Without it
         * Android falls back to a DEFAULT-importance channel: audible, but no
         * banner.
         */
        android: {
          priority: 'high' as const,
          notification: {
            channelId: ANDROID_CHANNEL_ID,
            sound: 'default',
            priority: 'high' as const,
            defaultVibrateTimings: true,
          },
        },
        apns: {
          headers: { 'apns-priority': '10' },
          payload: { aps: { sound: 'default', 'interruption-level': 'time-sensitive' } },
        },
      })),
    );

    const invalidTokens: string[] = [];
    response.responses.forEach((r, i) => {
      if (r.success) return;
      const code = (r.error as { code?: string } | undefined)?.code;
      if (code && DEAD_TOKEN_CODES.has(code)) invalidTokens.push(messages[i]!.token);
      else logger.warn({ code, err: r.error?.message }, 'FCM rejected one message');
    });

    return { sent: response.successCount, invalidTokens };
  } catch (err) {
    // A push failing must never fail the order that triggered it.
    logger.error({ err }, 'FCM send threw');
    return empty;
  }
}
