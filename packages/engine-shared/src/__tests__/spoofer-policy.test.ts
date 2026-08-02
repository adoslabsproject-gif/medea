/**
 * Tests spoofer-policy — decisione "spoofer → ban immediate".
 *
 * Coverage: tutti i 4 esiti (verified_legit, ua_claimed_spoofable,
 * allow_unknown) + casi anti-spoofing reali (fake-Googlebot da AWS oggi
 * nei nostri log).
 */
import { describe, it, expect } from 'vitest';
import {
  decideSpooferPolicy,
  isSpoofer,
  SPOOFER_BAN_DURATION_MS,
  SPOOFER_BAN_REASON_CODE,
} from '../spoofer-policy.js';

describe('decideSpooferPolicy — verified_legit', () => {
  it('Googlebot + PTR googlebot.com → allow_verified', () => {
    const d = decideSpooferPolicy(
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'crawl-66-249-72-1.googlebot.com',
    );
    expect(d.action).toBe('allow_verified');
    expect(d.claimedBotFamily).toBe('Googlebot');
    expect(d.banDurationMs).toBe(0);
    expect(d.severity).toBe('info');
  });

  it('Bingbot + PTR msn.com → allow_verified', () => {
    const d = decideSpooferPolicy(
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
      'msnbot-40-77-167-1.search.msn.com',
    );
    expect(d.action).toBe('allow_verified');
    expect(d.claimedBotFamily).toBe('Bingbot');
  });
});

describe('decideSpooferPolicy — allow_ua_trust (UA-only vendor)', () => {
  it('GPTBot (OpenAI, no suffix DNS) + PTR null → allow_verified via UA trust', () => {
    const d = decideSpooferPolicy(
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
      null,
    );
    expect(d.action).toBe('allow_verified');
    expect(d.claimedBotFamily).toBe('GPTBot');
  });
});

describe('decideSpooferPolicy — ua_claimed_spoofable → ban_immediate', () => {
  it('FAKE-Googlebot AWS Stockholm (caso REALE 2026-06-02): UA Googlebot + AWS PTR → ban_immediate', () => {
    const d = decideSpooferPolicy(
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'ec2-13-49-73-217.eu-north-1.compute.amazonaws.com',
    );
    expect(d.action).toBe('ban_immediate');
    expect(d.claimedBotFamily).toBe('Googlebot');
    expect(d.banDurationMs).toBe(SPOOFER_BAN_DURATION_MS);
    expect(d.severity).toBe('high');
    expect(d.reason).toContain('SPOOFER');
    expect(d.reason).toContain('Googlebot');
  });

  it('FAKE-Googlebot da residenziale (Hetzner customer) → ban_immediate', () => {
    const d = decideSpooferPolicy(
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'static.hetzner.de',
    );
    expect(d.action).toBe('ban_immediate');
  });

  it('FAKE-Bingbot DigitalOcean → ban_immediate', () => {
    const d = decideSpooferPolicy(
      'Mozilla/5.0 (compatible; bingbot/2.0)',
      'droplet-167-99-1-1.digitalocean.com',
    );
    expect(d.action).toBe('ban_immediate');
  });

  it('Yandexbot senza PTR (default non-strict) → allow_unknown (safety vs false positive)', () => {
    const d = decideSpooferPolicy(
      'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
      null,
    );
    // Non-strict default: PTR=null è evidence insufficiente → no ban
    expect(d.action).toBe('allow_unknown');
    expect(d.claimedBotFamily).toBe('Yandex');
  });

  it('Yandexbot senza PTR + strictMode=true → ban_immediate', () => {
    const d = decideSpooferPolicy('Mozilla/5.0 (compatible; YandexBot/3.0)', null, {
      strictMode: true,
    });
    expect(d.action).toBe('ban_immediate');
  });

  it('Applebot da AWS → ban_immediate', () => {
    const d = decideSpooferPolicy(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit Applebot',
      'ec2-1-2-3-4.compute.amazonaws.com',
    );
    expect(d.action).toBe('ban_immediate');
  });
});

describe('decideSpooferPolicy — allow_unknown (UA non bot)', () => {
  it('UA Chrome (umano) → allow_unknown', () => {
    const d = decideSpooferPolicy(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'residential-isp.it',
    );
    expect(d.action).toBe('allow_unknown');
    expect(d.claimedBotFamily).toBeNull();
  });

  it('UA Safari mobile → allow_unknown', () => {
    const d = decideSpooferPolicy(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile Safari/604.1',
      'mobile.tim.it',
    );
    expect(d.action).toBe('allow_unknown');
  });
});

describe('isSpoofer — shorthand helper', () => {
  it('FAKE-Googlebot AWS → true', () => {
    expect(
      isSpoofer(
        'Mozilla/5.0 (compatible; Googlebot/2.1)',
        'ec2-13-49-73-217.compute.amazonaws.com',
      ),
    ).toBe(true);
  });

  it('Real Googlebot → false', () => {
    expect(
      isSpoofer('Mozilla/5.0 (compatible; Googlebot/2.1)', 'crawl-66-249-72-1.googlebot.com'),
    ).toBe(false);
  });

  it('Chrome umano → false', () => {
    expect(isSpoofer('Mozilla/5.0 (Windows NT 10.0) Chrome/131.0', 'isp.it')).toBe(false);
  });
});

describe('SPOOFER policy constants', () => {
  it('ban duration = 7 giorni', () => {
    expect(SPOOFER_BAN_DURATION_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('reason code "bot_spoof_detected" (audit-grade)', () => {
    expect(SPOOFER_BAN_REASON_CODE).toBe('bot_spoof_detected');
  });
});
