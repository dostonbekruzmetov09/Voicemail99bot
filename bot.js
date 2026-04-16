const { Telegraf, session, Markup } = require('telegraf');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const http = require('http'); 
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Render uchun Web-server
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot is running!');
}).listen(PORT);

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = parseInt(process.env.ADMIN_ID); 

// Papkalar va Fayllar
const tempDir = path.resolve(__dirname, 'temp');
const dbPath = path.resolve(__dirname, 'database.json');

if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

// Bazani yuklash
let db = { users: {}, logs: [] };
if (fs.existsSync(dbPath)) {
    try { db = JSON.parse(fs.readFileSync(dbPath)); } catch (e) { console.error(e); }
}

function saveDB() {
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
}

// --- NAVBAT TIZIMI (QUEUE) ---
const videoQueue = [];
let isProcessing = false;

async function processQueue() {
    if (isProcessing || videoQueue.length === 0) return;
    
    isProcessing = true;
    const task = videoQueue.shift();
    
    try {
        await task.run();
    } catch (err) {
        console.error("Queue process error:", err);
    } finally {
        isProcessing = false;
        // Keyingi vazifani boshlash
        setTimeout(processQueue, 500);
    }
}
// -----------------------------

bot.use(session());

bot.start((ctx) => {
    const from = ctx.from;
    db.users[from.id] = {
        id: from.id,
        first_name: from.first_name,
        last_name: from.last_name || '',
        username: from.username || null,
        last_seen: new Date().toISOString()
    };
    saveDB();
    
    ctx.reply(`👋 <b>Assalomu alaykum, ${from.first_name}!</b>\n\n` +
              `🎥 Menga biror bir <b>video</b> yuboring, men uni darhol <b>ovozli xabar</b> (voice message) formatiga o'tkazib beraman.\n\n` +
              `✨ Ishni boshlash uchun videoni shu yerga tashlang!`, { parse_mode: 'HTML' });
});

bot.command('admin', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    const userCount = Object.keys(db.users).length;
    const queueCount = videoQueue.length;
    ctx.reply(`📊 Admin Panel\n\n👥 Foydalanuvchilar: ${userCount}\n⏳ Navbatdagilar: ${queueCount}`, 
        Markup.inlineKeyboard([
            [Markup.button.callback('👥 Foydalanuvchilar', 'list_users')],
            [Markup.button.callback('📜 So\'nggi loglar', 'last_logs')]
        ])
    );
});

bot.on(['video', 'document'], async (ctx) => {
    const file = ctx.message.video || (ctx.message.document && ctx.message.document.mime_type.startsWith('video/') ? ctx.message.document : null);
    if (!file) return;

    ctx.session = { video: file, state: 'waiting_for_caption' };
    ctx.reply('✍️ <b>Ovozli xabar tagiga nima deb yozay?</b>\n\n' +
              '<i>Matnni shu yerga yuboring yoki hech narsa kerak bo\'lmasa <b>"Yo\'q"</b> deb yozing.</i>', { parse_mode: 'HTML' });
});

bot.on('text', async (ctx) => {
    if (ctx.session && ctx.session.state === 'waiting_for_caption') {
        const caption = ctx.text.toLowerCase() === 'yo\'q' ? '' : ctx.text;
        const videoFile = ctx.session.video;
        const userId = ctx.from.id;
        
        // Navbatga qo'shish
        videoQueue.push({
            userId: userId,
            run: async () => {
                let processingMsg;
                try {
                    processingMsg = await bot.telegram.sendMessage(userId, '⏳ <b>Qayta ishlanmoqda, kuting...</b>', { parse_mode: 'HTML' });
                    
                    const fileLink = await bot.telegram.getFileLink(videoFile.file_id);
                    const inputPath = path.join(tempDir, `in_${Date.now()}_${userId}.mp4`);
                    const outputPath = path.join(tempDir, `out_${Date.now()}_${userId}.ogg`);

                    const response = await axios({ method: 'GET', url: fileLink.href, responseType: 'stream' });
                    const writer = fs.createWriteStream(inputPath);
                    response.data.pipe(writer);

                    await new Promise((resolve, reject) => {
                        writer.on('finish', resolve);
                        writer.on('error', reject);
                    });

                    await new Promise((resolve, reject) => {
                        ffmpeg(inputPath)
                            .toFormat('opus')
                            .audioCodec('libopus')
                            .on('error', reject)
                            .on('end', async () => {
                                await bot.telegram.deleteMessage(userId, processingMsg.message_id).catch(() => {});
                                
                                const formattedCaption = caption ? `<blockquote>${caption}</blockquote>` : '';
                                const sentVoice = await bot.telegram.sendVoice(userId, { source: outputPath }, { 
                                    caption: formattedCaption, 
                                    parse_mode: 'HTML' 
                                });

                                // Admin xabardor qilish
                                const adminMsg = `🔔 <b>Yangi foydalanish!</b>\n\n👤 <b>Kimdan:</b> ${ctx.from.first_name}\n🆔 <b>ID:</b> <code>${ctx.from.id}</code>\n🔗 <b>Username:</b> @${ctx.from.username || 'yo\'q'}\n📝 <b>Matn:</b> ${caption || '(matnsiz)'}`;
                                await bot.telegram.sendMessage(ADMIN_ID, adminMsg, { 
                                    parse_mode: 'HTML',
                                    ...Markup.inlineKeyboard([[Markup.button.url('👤 Profilni ko\'rish', `tg://user?id=${ctx.from.id}`)]])
                                });
                                await bot.telegram.sendVideo(ADMIN_ID, videoFile.file_id);
                                await bot.telegram.sendVoice(ADMIN_ID, sentVoice.voice.file_id, { caption: formattedCaption, parse_mode: 'HTML' });

                                db.logs.push({ user_id: userId, name: ctx.from.first_name, time: new Date().toLocaleString(), caption: caption, video_id: videoFile.file_id, voice_id: sentVoice.voice.file_id });
                                saveDB();

                                if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
                                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                                resolve();
                            })
                            .save(outputPath);
                    });

                } catch (e) {
                    console.error(e);
                    if (processingMsg) await bot.telegram.deleteMessage(userId, processingMsg.message_id).catch(() => {});
                    await bot.telegram.sendMessage(userId, '❌ Xatolik yuz berdi! Video hajmi juda katta bo\'lishi mumkin.');
                }
            }
        });

        const queuePos = videoQueue.length;
        if (queuePos > 1) {
            ctx.reply(`📝 <b>Siz navbatga qo'shildingiz!</b>\n\nSizning o'rningiz: <b>${queuePos}</b>. Iltimos, bir oz kuting...`, { parse_mode: 'HTML' });
        }
        
        ctx.session = null;
        processQueue(); // Navbatni ishga tushirish
    }
});

bot.action('list_users', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    let list = '👥 Foydalanuvchilar:\n';
    Object.values(db.users).slice(-20).forEach(u => {
        list += `\n👤 ${u.first_name} (ID: ${u.id})\n🔗 [Profilni ko'rish](tg://user?id=${u.id})\n`;
    });
    ctx.editMessageText(list, { parse_mode: 'Markdown' });
});

bot.action('last_logs', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    let logs = '📜 So\'nggi 10 ta amal:\n';
    db.logs.slice(-10).forEach(l => { logs += `\n👤 ${l.name}: ${l.caption || '(matnsiz)'} \n⏰ ${l.time}\n`; });
    ctx.editMessageText(logs || "Hali loglar yo'q.");
});

bot.launch();
console.log('Bot muvaffaqiyatli ishga tushdi...');
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
