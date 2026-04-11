import { getBotInfo } from '../detect';
import { getIpAddress } from '../ip';

const IP = '127.0.0.1';
test('getIpAddress: Custom header', () => {
  process.env.CLIENT_IP_HEADER = 'x-custom-ip-header';

  expect(getIpAddress(new Headers({ 'x-custom-ip-header': IP }))).toEqual(IP);
});

test('getIpAddress: CloudFlare header', () => {
  expect(getIpAddress(new Headers({ 'cf-connecting-ip': IP }))).toEqual(IP);
});

test('getIpAddress: Standard header', () => {
  expect(getIpAddress(new Headers({ 'x-forwarded-for': IP }))).toEqual(IP);
});

test('getIpAddress: No header', () => {
  expect(getIpAddress(new Headers())).toEqual(undefined);
});

test('getBotInfo: identifies AI crawlers', () => {
  expect(getBotInfo('Mozilla/5.0 (compatible; GPTBot/1.0; +https://openai.com/gptbot)')).toEqual({
    isBot: true,
    botName: 'GPTBot',
    botCategory: 'ai-crawler',
  });
});

test('getBotInfo: identifies search crawlers', () => {
  expect(
    getBotInfo('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'),
  ).toEqual({
    isBot: true,
    botName: 'Googlebot',
    botCategory: 'search-crawler',
  });
});

test('getBotInfo: ignores normal browsers', () => {
  expect(
    getBotInfo(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/123.0.0.0 Safari/537.36',
    ),
  ).toEqual({
    isBot: false,
    botName: null,
    botCategory: null,
  });
});
