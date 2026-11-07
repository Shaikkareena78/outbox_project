import { config } from "./config";
import { redis } from "./redis";

const hourlyReservationScript = `
local globalCount = redis.call('INCR', KEYS[1])
if globalCount == 1 then redis.call('EXPIRE', KEYS[1], 7200) end
local campaignCount = redis.call('INCR', KEYS[2])
if campaignCount == 1 then redis.call('EXPIRE', KEYS[2], 7200) end
if globalCount <= tonumber(ARGV[1]) and campaignCount <= tonumber(ARGV[2]) then return {1, 0} end
redis.call('DECR', KEYS[1])
redis.call('DECR', KEYS[2])
local claimed = redis.call('SET', KEYS[3], '1', 'EX', 7200, 'NX')
local now = tonumber(ARGV[3])
local nextHour = (math.floor(now / 3600000) + 1) * 3600000
return {0, nextHour, claimed and 1 or 0}
`;

const hourlyCheckScript = `
local globalCount = tonumber(redis.call('GET', KEYS[1]) or '0')
local campaignCount = tonumber(redis.call('GET', KEYS[2]) or '0')
if globalCount < tonumber(ARGV[1]) and campaignCount < tonumber(ARGV[2]) then return {1, 0} end
local claimed = redis.call('SET', KEYS[3], '1', 'EX', 7200, 'NX')
local now = tonumber(ARGV[3])
local nextHour = (math.floor(now / 3600000) + 1) * 3600000
return {0, nextHour, claimed and 1 or 0}
`;

const throttleScript = `
local ttl = redis.call('PTTL', KEYS[1])
if ttl > 0 then return ttl end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return 0
`;

const releaseThrottleScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

const releaseSendScript = `
for i = 1, 2 do
  local count = tonumber(redis.call('GET', KEYS[i]) or '0')
  if count > 0 then redis.call('DECR', KEYS[i]) end
end
return 1
`;

export interface RateDecision {
  allowed: boolean;
  delayUntil?: number;
  notify: boolean;
}

function senderRateKeys(sender: string, campaignId: string, userId: string, now: number): [string, string, string] {
  const senderKey = Buffer.from(sender.toLowerCase()).toString("hex");
  const campaignKey = Buffer.from(campaignId).toString("hex");
  const userKey = Buffer.from(userId).toString("hex");
  const hourWindow = Math.floor(now / 3_600_000);
  return [
    `email-rate:${senderKey}:${hourWindow}`,
    `email-rate:${senderKey}:${campaignKey}:${hourWindow}`,
    `email-rate-notified:${senderKey}:${userKey}:${hourWindow}`
  ];
}

function limits(requestedLimit: number): [number, number] {
  return [
    config.MAX_EMAILS_PER_HOUR_PER_SENDER,
    Math.min(requestedLimit, config.MAX_EMAILS_PER_HOUR_PER_SENDER)
  ];
}

function rateDecision(result: [number, number, number?]): RateDecision {
  if (Number(result[0]) === 1) return { allowed: true, notify: false };
  return {
    allowed: false,
    delayUntil: Number(result[1]),
    notify: Number(result[2] ?? 0) === 1
  };
}

export async function checkSendAvailability(
  sender: string,
  requestedLimit: number,
  campaignId: string,
  userId: string
): Promise<RateDecision> {
  const now = Date.now();
  const [globalKey, campaignKey, notificationKey] = senderRateKeys(sender, campaignId, userId, now);
  const [globalLimit, campaignLimit] = limits(requestedLimit);
  const result = await redis.eval(
    hourlyCheckScript,
    3,
    globalKey,
    campaignKey,
    notificationKey,
    String(globalLimit),
    String(campaignLimit),
    String(now)
  ) as [number, number, number?];
  return rateDecision(result);
}

export async function reserveSend(
  sender: string,
  requestedLimit: number,
  campaignId: string,
  userId: string
): Promise<RateDecision> {
  const now = Date.now();
  const [globalKey, campaignKey, notificationKey] = senderRateKeys(sender, campaignId, userId, now);
  const [globalLimit, campaignLimit] = limits(requestedLimit);
  const result = await redis.eval(
    hourlyReservationScript,
    3,
    globalKey,
    campaignKey,
    notificationKey,
    String(globalLimit),
    String(campaignLimit),
    String(now)
  ) as [number, number, number?];
  return rateDecision(result);
}

export async function releaseSendReservation(
  sender: string,
  campaignId: string,
  userId: string
): Promise<void> {
  const [globalKey, campaignKey] = senderRateKeys(sender, campaignId, userId, Date.now());
  await redis.eval(releaseSendScript, 2, globalKey, campaignKey);
}

export async function reserveThrottle(sender: string, reservationId: string): Promise<number> {
  if (config.MIN_SEND_INTERVAL_MS === 0) return 0;
  const senderKey = Buffer.from(sender.toLowerCase()).toString("hex");
  const ttl = await redis.eval(
    throttleScript,
    1,
    `email-throttle:${senderKey}`,
    reservationId,
    String(config.MIN_SEND_INTERVAL_MS)
  );
  return Number(ttl);
}

export async function releaseThrottle(sender: string, reservationId: string): Promise<void> {
  const senderKey = Buffer.from(sender.toLowerCase()).toString("hex");
  await redis.eval(
    releaseThrottleScript,
    1,
    `email-throttle:${senderKey}`,
    reservationId
  );
}

export async function releaseRateNotification(sender: string, userId: string): Promise<void> {
  const senderKey = Buffer.from(sender.toLowerCase()).toString("hex");
  const userKey = Buffer.from(userId).toString("hex");
  const hourWindow = Math.floor(Date.now() / 3_600_000);
  await redis.del(`email-rate-notified:${senderKey}:${userKey}:${hourWindow}`);
}
