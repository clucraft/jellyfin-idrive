'use strict';
/**
 * fake-player.js - the tests' stand-in for tvh-player: the same stdin, control pipe (fd 3) and "MGU {json}" events,
 * but it decodes nothing. It keeps the film's time on a clock that runs FAKE_SPEED times faster than real time, reads
 * no more than 6 s ahead of it (so the pipe's backpressure is real), and says what the real one says: open, decoder,
 * audio, a tick every 50 ms (t: seconds played, state: starting / playing / buffering / paused), end.
 *
 * How many seconds it has been given:
 *   - the mock server's "film" is filler, 20 000 bytes a second (tools/mock-jellyfin.js): its bytes are counted;
 *   - a real server's film (the emulator with "Other server") is MPEG-TS: its picture's own time stamps are read, so
 *     the film's place is the true one whatever its bitrate.
 *
 *   FAKE_SPEED (default 20)   FAKE_AUDIO_ERROR=1: the sound is refused   FAKE_CRASH_AT=<s>: exits there, once
 */
const fs = require('fs');
const BPS = 20000, AHEAD = 6;
const speed = Number(process.env.FAKE_SPEED) || 20;
const out = (o) => process.stdout.write('MGU ' + JSON.stringify(o) + '\n');
let bytes = 0, eof = false, t = 0, paused = false, started = false, opened = false, last = Date.now(), gain = 0;

/* ---------- MPEG-TS: the seconds between the first and the latest time stamp of a picture (or, without one, a sound) ---------- */
const ts = { on: null, rest: Buffer.alloc(0), first: null, max: null, video: false };
function stamps(d) {
    let b = ts.rest.length ? Buffer.concat([ts.rest, d]) : d;
    if (ts.on === null) {
        if (b.length < 189 * 2) { ts.rest = b; return; }
        ts.on = b[0] === 0x47 && b[188] === 0x47 && b[376] === 0x47;
    }
    if (!ts.on) { ts.rest = Buffer.alloc(0); return; }
    let i = 0;
    for (; i + 188 <= b.length; i += 188) {
        if (b[i] !== 0x47) { const n = b.indexOf(0x47, i + 1); if (n < 0) { i = b.length; break; } i = n - 188; continue; }   // lost its place: the next sync byte
        if (!(b[i + 1] & 0x40)) continue;                                 // not the start of a packet of picture or sound
        const afc = (b[i + 3] >> 4) & 3;
        if (!(afc & 1)) continue;
        const p = i + 4 + (afc & 2 ? 1 + b[i + 4] : 0);
        if (p + 14 > i + 188 || b[p] !== 0 || b[p + 1] !== 0 || b[p + 2] !== 1 || !(b[p + 7] & 0x80)) continue;
        const sid = b[p + 3], video = sid >= 0xe0 && sid <= 0xef;
        if (!video && !(sid >= 0xc0 && sid <= 0xdf) && sid !== 0xbd) continue;
        if (ts.video && !video) continue;
        if (video && !ts.video) { ts.video = true; ts.first = null; ts.max = null; }
        const pts = ((b[p + 9] >> 1) & 7) * 1073741824 + b[p + 10] * 4194304 + (b[p + 11] >> 1) * 32768 + b[p + 12] * 128 + (b[p + 13] >> 1);
        if (ts.first === null || pts < ts.first) ts.first = pts;
        if (ts.max === null || pts > ts.max) ts.max = pts;
    }
    ts.rest = i < b.length ? b.slice(i) : Buffer.alloc(0);
}
/** the seconds of film it has been given */
const given = () => (ts.on && ts.first !== null ? (ts.max - ts.first) / 90000 : ts.on ? 0 : bytes / BPS);

function open() {
    if (opened) return;
    opened = true;
    out({ ev: 'open', video: { codec: 'h264', w: 1280, h: 720, fps: 25, interlaced: false }, audio: { codec: 'aac', rate: 48000, channels: 2 }, duration: 0 });
    out({ ev: 'decoder', ok: true, path: process.env.MGU_VIDEO_PATH || '', w: 1280, h: 720 });
    if (process.env.FAKE_AUDIO_ERROR) out({ ev: 'audio', ok: false, error: 'snd_pcm_open: Operation not permitted' });
    else out({ ev: 'audio', ok: true, device: process.env.MGU_AUDIO || '', codec: 'aac', rate: 48000, channels: 2 });
}
process.stdin.on('data', (d) => {
    bytes += d.length;
    stamps(d);
    if (bytes > 0) open();
    if (given() - t > AHEAD) process.stdin.pause();
});
process.stdin.on('end', () => { eof = true; });
process.stdin.on('error', () => { eof = true; });

let ctl = '';
try {
    const c = fs.createReadStream(null, { fd: 3 });
    c.setEncoding('utf8');
    c.on('data', (d) => {
        ctl += d;
        let i;
        while ((i = ctl.indexOf('\n')) >= 0) {
            const line = ctl.slice(0, i).trim(); ctl = ctl.slice(i + 1);
            if (line === 'pause') paused = true;
            else if (line === 'resume') { paused = false; last = Date.now(); }
            else if (line.indexOf('gain ') === 0) gain = Number(line.slice(5)) || 0;
            else if (line === 'quit') process.exit(0);
        }
    });
    c.on('error', () => {});
} catch (e) { /* no control pipe */ }

setInterval(() => {
    const now = Date.now(), have = given();
    let state = 'starting';
    if (!started && (have >= 1 || (eof && bytes > 0))) { started = true; last = now; }
    if (started) {
        if (paused) state = 'paused';
        else {
            const want = t + (now - last) / 1000 * speed;
            t = Math.min(want, have);
            state = want > have && !eof ? 'buffering' : 'playing';
        }
    }
    last = now;
    if (opened) out({ ev: 'tick', t: Math.round(t * 1000) / 1000, pos: Math.round(t * 1000) / 1000, state, shown: Math.round(t * 25), late: 0, decerr: 0, buffered: Math.round((have - t) * 10) / 10, gain });
    if (process.env.FAKE_CRASH_AT && t >= Number(process.env.FAKE_CRASH_AT) && !fs.existsSync(process.env.FAKE_CRASH_FLAG || '/nonexistent')) {
        try { fs.writeFileSync(process.env.FAKE_CRASH_FLAG, '1'); } catch (e) { /* no flag: crashes each time */ }
        process.exit(3);
    }
    if (have - t <= AHEAD / 2) process.stdin.resume();
    if (eof && t >= have - 1e-6) { out({ ev: 'end', t, bytes, shown: Math.round(t * 25), late: 0, aplayed: Math.round(t * 47) }); process.exit(0); }
}, 50);
