import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * §15 NOTIFICATIONS — Expo Push (D13), one API reaching both APNs and FCM.
 * The delivery staff PWA uses Web Push instead (out of scope for this
 * client — Expo tokens only apply to the Expo-built customer app).
 */

type ExpoMessage = {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
};

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

export async function sendExpoPush(messages: ExpoMessage[]): Promise<void> {
  if (messages.length === 0) return;
  if (!env.EXPO_ACCESS_TOKEN) {
    logger.info({ count: messages.length }, '[dev] Expo push (no EXPO_ACCESS_TOKEN configured, not sent)');
    return;
  }

  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(messages),
    });
    if (!response.ok) {
      logger.error({ status: response.status }, 'Expo push send failed');
    }
  } catch (err) {
    logger.error({ err }, 'Expo push send threw');
  }
}
