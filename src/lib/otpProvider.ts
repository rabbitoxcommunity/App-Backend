import { logger } from '../config/logger.js';
import { env } from '../config/env.js';

/**
 * §5.3 — OTP provider is a SWAPPABLE module. UAE SMS needs a registered
 * sender ID via an aggregator; WhatsApp needs a Meta BSP and a pre-approved
 * template. Both have multi-week lead times — see §5.3's note in the design
 * doc. Ship the console provider for dev; wire a real one in before launch.
 */
export interface OtpProvider {
  send(phone: string, code: string, channel: 'sms' | 'whatsapp'): Promise<void>;
}

class ConsoleOtpProvider implements OtpProvider {
  async send(phone: string, code: string, channel: 'sms' | 'whatsapp'): Promise<void> {
    logger.info({ phone, code, channel }, '[dev] OTP code (console provider — not sent for real)');
  }
}

class SmsOtpProvider implements OtpProvider {
  async send(phone: string, code: string): Promise<void> {
    if (!env.OTP_API_KEY || !env.OTP_SENDER_ID) {
      throw new Error('OTP_PROVIDER=sms but OTP_API_KEY / OTP_SENDER_ID are not configured.');
    }
    // Wire the aggregator's REST call here once credentials exist.
    throw new Error('SMS provider not yet wired to a real aggregator — see §5.3.');
  }
}

class WhatsAppOtpProvider implements OtpProvider {
  async send(phone: string, code: string): Promise<void> {
    if (!env.WHATSAPP_BSP_KEY) {
      throw new Error('OTP_PROVIDER=whatsapp but WHATSAPP_BSP_KEY is not configured.');
    }
    // Wire the Meta BSP template send here once the template is approved.
    throw new Error('WhatsApp provider not yet wired to a BSP — see §5.3.');
  }
}

export function getOtpProvider(): OtpProvider {
  switch (env.OTP_PROVIDER) {
    case 'sms':
      return new SmsOtpProvider();
    case 'whatsapp':
      return new WhatsAppOtpProvider();
    default:
      return new ConsoleOtpProvider();
  }
}
