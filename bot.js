import { ChannelType, Client, GatewayIntentBits, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import fs from 'node:fs';

const FILE = 'alarms.json';
const DAYS = '일월화수목금토';
const EMOJI = '✅';

// 한국시간 기준으로 지금 울려야 하는 알림인지. days 없으면 매일
export function due(alarm, date) {
  const kst = new Date(date.getTime() + 9 * 3600e3);
  const hhmm = kst.toISOString().slice(11, 16);
  return hhmm === alarm.time && (!alarm.days || alarm.days.includes(kst.getUTCDay()));
}

// "월,수,금" / "월수금" / "토요일" -> [1,3,5] 등. 비우면 null(매일), 잘못되면 undefined
export function parseDays(s) {
  if (!s) return null;
  const days = [...s.replace(/요일|[\s,]/g, '')].map(c => DAYS.indexOf(c));
  return days.length && !days.includes(-1) ? [...new Set(days)].sort() : undefined;
}

// "9:00" -> "09:00", 잘못되면 null
export function parseTime(s) {
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(s.trim());
  return m && +m[1] < 24 ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
}

if (process.argv[2] === 'test') {
  const weekly = { time: '20:50', days: [6] }, daily = { time: '21:50' };
  console.assert(due(weekly, new Date('2026-10-10T11:50:00Z')), 'weekly fires on sat');
  console.assert(!due(weekly, new Date('2026-10-11T11:50:00Z')), 'weekly not on sun');
  console.assert(due(daily, new Date('2026-10-11T12:50:00Z')), 'daily fires');
  console.assert(String(parseDays('금, 월 수')) === '1,3,5' && String(parseDays('토요일')) === '6', 'days');
  console.assert(parseDays('') === null && parseDays('월x') === undefined, 'days edge');
  console.assert(parseTime('9:05') === '09:05' && parseTime('24:00') === null, 'time');
  console.log('ok');
  process.exit();
}

let alarms = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : [];
const save = () => fs.writeFileSync(FILE, JSON.stringify(alarms, null, 2));
const describe = a => `**${a.name}** — ${a.days ? a.days.map(d => DAYS[d]).join(',') + '요일' : '매일'} ${a.time}`;

const admin = PermissionFlagsBits.ManageGuild;
const commands = [
  new SlashCommandBuilder().setName('알림목록').setDescription('등록된 알림을 봅니다'),
  new SlashCommandBuilder().setName('알림추가').setDescription('새 알림을 등록합니다').setDefaultMemberPermissions(admin)
    .addStringOption(o => o.setName('이름').setDescription('예: 보스').setRequired(true))
    .addStringOption(o => o.setName('시간').setDescription('한국시간 HH:MM (예: 21:50)').setRequired(true))
    .addStringOption(o => o.setName('내용').setDescription('알림 때 보낼 문구').setRequired(true))
    .addStringOption(o => o.setName('요일').setDescription('예: 토 / 월,수,금 (비우면 매일)'))
    .addChannelOption(o => o.setName('채널').setDescription('알림 보낼 채널 (비우면 지금 채널)')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
  new SlashCommandBuilder().setName('알림삭제').setDescription('알림을 삭제합니다').setDefaultMemberPermissions(admin)
    .addStringOption(o => o.setName('이름').setDescription('삭제할 알림').setRequired(true).setAutocomplete(true)),
];

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// 서버마다 명령어 등록 (서버 명령어라 바로 반영됨) + 닉네임 설정
async function setupGuild(guild) {
  await guild.commands.set(commands);
  await guild.members.me.setNickname('좋은하루').catch(e => console.error('닉네임 변경 실패', guild.name, e.message));
}
client.on('guildCreate', setupGuild);

client.on('interactionCreate', async i => {
  const mine = alarms.filter(a => a.guildId === i.guildId);
  if (i.isAutocomplete()) {
    const q = i.options.getFocused();
    return i.respond(mine.filter(a => a.name.includes(q)).slice(0, 25).map(a => ({ name: a.name, value: a.name })));
  }
  if (!i.isChatInputCommand()) return;
  const reply = content => i.reply({ content, flags: MessageFlags.Ephemeral });
  const name = i.options.getString('이름');

  if (i.commandName === '알림목록') {
    return reply(mine.length ? mine.map(a => `${describe(a)} → <#${a.channelId}>`).join('\n') : '등록된 알림이 없습니다.');
  }

  if (i.commandName === '알림추가') {
    const time = parseTime(i.options.getString('시간'));
    const days = parseDays(i.options.getString('요일'));
    const channel = i.options.getChannel('채널') ?? i.channel;
    if (!time) return reply('시간 형식이 잘못됐어요. 예: 21:50');
    if (days === undefined) return reply('요일 형식이 잘못됐어요. 예: 토 / 월,수,금');
    if (mine.some(a => a.name === name)) return reply('같은 이름의 알림이 이미 있어요.');
    const alarm = { name, time, days, text: i.options.getString('내용') };
    let msg;
    try {
      msg = await channel.send(`🔔 ${describe(alarm)} 알림\n받으려면 ${EMOJI}를 눌러주세요.`);
      await msg.react(EMOJI);
    } catch {
      return reply(`${channel}에 메시지를 보낼 수 없어요. 봇 권한(보기/보내기/반응 추가)을 확인해주세요.`);
    }
    alarms.push({ ...alarm, guildId: i.guildId, channelId: channel.id, msgId: msg.id });
    save();
    return reply(`등록했어요: ${describe(alarm)} → ${channel}`);
  }

  if (i.commandName === '알림삭제') {
    const alarm = mine.find(a => a.name === name);
    if (!alarm) return reply('그런 이름의 알림이 없어요.');
    alarms = alarms.filter(a => a !== alarm);
    save();
    // 채널이나 메시지가 이미 지워졌으면 무시
    await client.channels.fetch(alarm.channelId).then(c => c.messages.delete(alarm.msgId)).catch(() => {});
    return reply(`삭제했어요: ${alarm.name}`);
  }
});

const fired = new Set();
client.once('clientReady', async () => {
  await Promise.all(client.guilds.cache.map(setupGuild));
  console.log(`${client.user.tag} 준비 완료`);

  setInterval(async () => {
    const now = new Date();
    for (const alarm of alarms) {
      const key = `${alarm.msgId}@${now.toISOString().slice(0, 16)}`;
      if (!due(alarm, now) || fired.has(key)) continue;
      fired.add(key);
      try {
        const channel = await client.channels.fetch(alarm.channelId);
        const msg = await channel.messages.fetch(alarm.msgId);
        // ponytail: 반응자 100명까지만 가져옴, 더 많아지면 after로 페이지네이션
        const users = await msg.reactions.cache.get(EMOJI)?.users.fetch();
        const mentions = users?.filter(u => !u.bot).map(u => `<@${u.id}>`) ?? [];
        if (mentions.length) await channel.send(`${mentions.join(' ')}\n${alarm.text}`);
      } catch (e) {
        console.error(alarm.name, e);
      }
    }
  }, 20_000);
});

client.login(process.env.DISCORD_TOKEN);
