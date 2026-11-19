'use strict';
/**
 * Tests of the Drivefin app and its service. No car, no Jellyfin server and no network are needed:
 *
 *   node test/run.js                      on this computer's Node
 *   node tools/node8.js test/run.js       on Node 8, as the head unit runs both
 *
 * - the pieces: the HLS playlist reader, the Jellyfin answers' mapping, the addresses a typed one may mean, the drive
 *   gate and the passenger disclaimer's consent, the posters' scaling, the texts
 * - the service (native/clucraft-jellyfin) against a stand-in server (tools/mock-jellyfin.js), with a stand-in
 *   player (test/fake-player.js): the server's address, Quick Connect, a name and password, an older server, the
 *   library, playing, pausing, skipping, the end, the next episode and its tracks, a stream that breaks, a server
 *   that refuses, the app going away
 * - the app's store and pages (tools/stage.js): every page drawn, taps on its targets, the picture off while driving
 * - main.js on a stand-in head unit, from the package the kit's build stages (needs Python 3; skipped without)
 * - the repository: versions and manifests agree
 *
 * What these cannot say is listed in the README ("What still needs a car"): the real player on the real GPU and
 * speakers, and a real Jellyfin server's transcoder.
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const assert = require('assert');
const Module = require('module');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'apps', 'clucraft_jellyfin');
const SVC = path.join(ROOT, 'native', 'clucraft-jellyfin');
const { createStage, sleep } = require(path.join(ROOT, 'tools', 'stage'));
const { createMock, TOKEN, USER, PASSWORD, USER_ID } = require(path.join(ROOT, 'tools', 'mock-jellyfin'));

// the service logs to the console: kept out of the tests' own lines (TEST_LOG=1 shows it)
const print = console.log.bind(console);
if (!process.env.TEST_LOG) console.log = () => {};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const near = (a, b, eps, what) => assert.ok(Math.abs(a - b) <= eps, (what || 'value') + ' ' + a + ' is not within ' + eps + ' of ' + b);
const hex = (c) => new Array(33).join(c);       // an item's id, as Jellyfin writes one: 32 hex digits
const rejects = (p, re) => p.then(() => { throw new Error('it did not fail'); }, (e) => assert.ok(re.test(String(e && e.message)), String(e && e.message)));

/* ---------------- the pieces ---------------- */

test('hls: a master playlist names its stream, a media playlist its segments', () => {
    const { parsePlaylist } = require(path.join(SVC, 'hls'));
    const m = parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1280x720\nmain.m3u8?PlaySessionId=abc\n');
    assert.deepStrictEqual(m.master, ['main.m3u8?PlaySessionId=abc']);
    assert.strictEqual(m.segments.length, 0);
    const p = parsePlaylist('#EXTM3U\r\n#EXT-X-VERSION:3\r\n#EXT-X-TARGETDURATION:6\r\n#EXT-X-MEDIA-SEQUENCE:7\r\n#EXTINF:6.000000, nodesc\r\nhls1/main/7.ts?a=1\r\n#EXTINF:2.5, nodesc\r\nhls1/main/8.ts?a=1\r\n');
    assert.deepStrictEqual(p.segments, [{ uri: 'hls1/main/7.ts?a=1', dur: 6 }, { uri: 'hls1/main/8.ts?a=1', dur: 2.5 }]);
    assert.strictEqual(p.endlist, false); assert.strictEqual(p.target, 6); assert.strictEqual(p.sequence, 7);
    assert.strictEqual(parsePlaylist(p.segments.map((s) => '#EXTINF:' + s.dur + ',\n' + s.uri).join('\n') + '\n#EXT-X-ENDLIST').endlist, true);
});

test('hls: reading starts at the segment that holds the offset when the list is the whole film, else at its first', () => {
    const { startAt } = require(path.join(SVC, 'hls'));
    const segs = Array.from({ length: 30 }, () => ({ uri: 'x', dur: 4 }));       // 120 s
    assert.deepStrictEqual(startAt(segs, 50, 120), { index: 12, base: 48, mode: 'seek', seconds: 120 });
    assert.deepStrictEqual(startAt(segs, 0, 120), { index: 0, base: 0, mode: 'offset', seconds: 120 });
    // the list is only what follows the offset (120 s of a 600 s film asked for at 480 s)
    assert.deepStrictEqual(startAt(segs, 480, 600), { index: 0, base: 480, mode: 'offset', seconds: 120 });
    assert.strictEqual(startAt(segs, 119.9, 120).index, 29);
});

test('jellyfin: an item and its tracks as the app gets them', () => {
    const { view, mediaOf } = require(path.join(SVC, 'jellyfin'));
    const ep = hex('a'), se = hex('b'), sh = hex('c');
    const it = view({ Id: ep, Type: 'Episode', Name: 'Pilot', RunTimeTicks: 25200000000, UserData: { PlaybackPositionTicks: 610000000, Played: false, PlayCount: 1 }, IndexNumber: 1, ParentIndexNumber: 2,
        SeasonId: se, SeasonName: 'Season 2', SeriesId: sh, SeriesName: 'A Show', SeriesPrimaryImageTag: 'abc123', CommunityRating: 8.25, PremiereDate: '2020-03-01T00:00:00.0000000Z',
        ImageTags: { Primary: 'ffee' }, Overview: 'One<br/>two <b>three</b>' });
    assert.deepStrictEqual([it.key, it.type, it.duration, it.viewOffset, it.viewCount, it.year, it.parentKey, it.parentTitle, it.grandparentKey, it.rating, it.index, it.parentIndex],
        [ep, 'episode', 2520, 61, 0, 2020, se, 'Season 2', sh, 8.3, 1, 2]);
    assert.deepStrictEqual([it.thumb, it.grandparentThumb, it.summary], ['/Items/' + ep + '/Images/Primary?tag=ffee', '/Items/' + sh + '/Images/Primary?tag=abc123', 'One two three']);
    // a show: how many episodes, how many of them watched (the server counts those that are not)
    const show = view({ Id: sh, Type: 'Series', Name: 'A Show', ChildCount: 2, RecursiveItemCount: 16, UserData: { UnplayedItemCount: 5, Played: false } });
    assert.deepStrictEqual([show.type, show.leafCount, show.viewedLeafCount, show.childCount, show.viewCount], ['show', 16, 11, 2, 0]);
    const season = view({ Id: se, Type: 'Season', Name: 'Season 2', IndexNumber: 2, SeriesId: sh, SeriesName: 'A Show', ChildCount: 8, UserData: { UnplayedItemCount: 0, Played: true } });
    assert.deepStrictEqual([season.type, season.leafCount, season.viewedLeafCount, season.parentKey, season.parentTitle, season.index], ['season', 8, 8, sh, 'A Show', 2]);
    assert.strictEqual(view({ Id: hex('d'), Type: 'Movie', Name: 'Seen', UserData: { Played: true, PlayCount: 0 } }).viewCount, 1);
    // what is no film, show, season or episode is left out; so is an item without an id
    assert.strictEqual(view({ Id: hex('d'), Type: 'MusicAlbum', Name: 'An album' }), null);
    assert.strictEqual(view({ Type: 'Movie', Name: 'no id' }), null);
    const md = mediaOf({ MediaSources: [{ Id: hex('d'), Container: 'mkv', Bitrate: 12400000, DefaultAudioStreamIndex: 2, DefaultSubtitleStreamIndex: -1, MediaStreams: [
        { Index: 0, Type: 'Video', Codec: 'hevc', BitDepth: 10, Width: 3840, Height: 1600 },
        { Index: 1, Type: 'Audio', Codec: 'truehd', Channels: 8, Language: 'eng', DisplayTitle: 'English - TrueHD - 7.1' },
        { Index: 2, Type: 'Audio', Codec: 'ac3', Channels: 6, Language: 'ger', DisplayTitle: 'German - Dolby Digital - 5.1 - Default' },
        { Index: 3, Type: 'Subtitle', Codec: 'PGSSUB', Language: 'eng', DisplayTitle: 'English - PGSSUB' }] }] });
    assert.deepStrictEqual([md[0].id, md[0].resolution, md[0].videoCodec, md[0].bitDepth, md[0].kbps, md[0].audioCodec, md[0].channels], [hex('d'), '4k', 'hevc', 10, 12400, 'ac3', 6]);
    assert.deepStrictEqual(md[0].audio.map((a) => a.id + (a.selected ? '*' : '') + a.lang), ['1eng', '2*ger']);
    assert.deepStrictEqual(md[0].subtitles, [{ id: '3', name: 'English - PGSSUB', codec: 'PGSSUB', selected: false, lang: 'eng' }]);
});

test('jellyfin: the addresses a typed one may mean: https first, Jellyfin\'s own port, as typed when it says http', () => {
    const { candidates } = require(path.join(SVC, 'jellyfin'));
    assert.deepStrictEqual(candidates('Jellyfin.Example.com'), ['https://jellyfin.example.com', 'http://jellyfin.example.com:8096', 'http://jellyfin.example.com']);
    assert.deepStrictEqual(candidates(' https://jf.example.com/ '), ['https://jf.example.com']);
    assert.deepStrictEqual(candidates('http://example.com/jellyfin/'), ['http://example.com/jellyfin']);
    assert.deepStrictEqual(candidates('203.0.113.7'), ['http://203.0.113.7:8096', 'https://203.0.113.7', 'http://203.0.113.7']);
    assert.deepStrictEqual(candidates('203.0.113.7:8096'), ['http://203.0.113.7:8096', 'https://203.0.113.7:8096']);
    assert.deepStrictEqual(candidates('example.com:8920'), ['https://example.com:8920', 'http://example.com:8920']);
    // a space typed by mistake is no part of an address
    assert.deepStrictEqual(candidates('jf. example.com'), candidates('jf.example.com'));
    ['', 'not an address!', 'ftp://example.com', 'example.com:99999', 'example.com/a?b=1', 'javascript:alert(1)', 'x'.repeat(300)].forEach((t) => assert.deepStrictEqual(candidates(t), [], t));
});

test('jellyfin: what is asked to play a film; the token is in a header and never in an address', async () => {
    const { createJellyfin } = require(path.join(SVC, 'jellyfin'));
    const asked = [];
    const nx = { request: (r) => {
        asked.push(r);
        // as the real server: the address it hands out has the token in it
        return Promise.resolve({ status: 200, headers: {}, body: Buffer.from(JSON.stringify({ PlaySessionId: 'ps1', MediaSources: [{ Id: hex('7'), TranscodingSubProtocol: 'hls',
            TranscodingUrl: '/videos/' + hex('7') + '/master.m3u8?DeviceId=x&MediaSourceId=' + hex('7') + '&api_key=SECRET-TOKEN&PlaySessionId=ps1&TranscodeReasons=ContainerNotSupported,AudioCodecNotSupported' }] })) });
    } };
    const jf = createJellyfin({ nx, device: { id: 'drivefin-test', name: 'BMW iDrive 7', version: '0.1.0' } });
    jf.use({ url: 'https://jf.example.com/', token: 'SECRET-TOKEN', userId: hex('1') });
    const d = await jf.playback({ key: hex('7'), offset: 61.7, quality: '720', audio: 2, subtitle: -1 });
    assert.deepStrictEqual([d.ok, d.session, d.sourceId, d.how], [true, 'ps1', hex('7'), 'direct stream']);
    assert.strictEqual(d.url, 'https://jf.example.com/videos/' + hex('7') + '/master.m3u8?DeviceId=x&MediaSourceId=' + hex('7') + '&PlaySessionId=ps1&TranscodeReasons=ContainerNotSupported,AudioCodecNotSupported');
    const r = asked[0], b = JSON.parse(r.body ? JSON.stringify(r.body) : '{}');
    assert.ok(r.url.indexOf('https://jf.example.com/Items/' + hex('7') + '/PlaybackInfo?') === 0 && r.method === 'POST', r.url);
    assert.ok(r.url.indexOf('SECRET') < 0 && !/api_key|token/i.test(r.url), 'the token is in the address');
    assert.strictEqual(r.headers.Authorization, 'MediaBrowser Client="Drivefin", Device="BMW iDrive 7", DeviceId="drivefin-test", Version="0.1.0", Token="SECRET-TOKEN"');
    assert.strictEqual(jf.headers().Authorization, r.headers.Authorization);
    assert.deepStrictEqual([b.StartTimeTicks, b.MaxStreamingBitrate, b.AudioStreamIndex, b.SubtitleStreamIndex, b.EnableDirectPlay, b.EnableDirectStream, b.EnableTranscoding, b.AlwaysBurnInSubtitleWhenTranscoding],
        [610000000, 4000000, 2, -1, false, false, true, true]);
    const tp = b.DeviceProfile.TranscodingProfiles[0], limits = {};
    b.DeviceProfile.CodecProfiles[0].Conditions.forEach((c) => { limits[c.Property] = c.Value; });
    assert.deepStrictEqual([tp.Container, tp.VideoCodec, tp.AudioCodec, tp.Protocol, tp.MaxAudioChannels, b.DeviceProfile.DirectPlayProfiles.length], ['ts', 'h264', 'aac', 'hls', '2', 0]);
    assert.deepStrictEqual([limits.VideoBitDepth, limits.Width, limits.Height, limits.VideoRangeType], ['8', '1280', '720', 'SDR']);
    assert.strictEqual(jf.profile({ w: 640, h: 360, kbps: 720 }).MaxStreamingBitrate, 720000);
    // an unknown quality is the default one; a picture that has to be made anew is a transcode
    asked.length = 0;
    nx.request = (q) => { asked.push(q); return Promise.resolve({ status: 200, headers: {}, body: Buffer.from(JSON.stringify({ PlaySessionId: 'ps2', MediaSources: [{ Id: hex('7'), TranscodingSubProtocol: 'hls',
        TranscodingUrl: '/videos/x/master.m3u8?ApiKey=SECRET-TOKEN&TranscodeReasons=ContainerBitrateExceedsLimit' }] })) }); };
    const d2 = await jf.playback({ key: hex('7'), quality: 'nonsense' });
    assert.deepStrictEqual([d2.how, d2.url, asked[0].body.MaxStreamingBitrate, 'AudioStreamIndex' in asked[0].body], ['transcode', 'https://jf.example.com/videos/x/master.m3u8?TranscodeReasons=ContainerBitrateExceedsLimit', 4000000, false]);
    // the server's refusal, in words
    nx.request = () => Promise.resolve({ status: 200, headers: {}, body: Buffer.from(JSON.stringify({ MediaSources: [], ErrorCode: 'NotAllowed' })) });
    const d3 = await jf.playback({ key: hex('7') });
    assert.ok(d3.ok === false && /may not play/.test(d3.text), d3.text);
    // a picture's address is only ever an item's picture
    await rejects(jf.image('/System/Logs/Log?name=x', 10, 10), /not a picture/);
    await rejects(jf.image('/Items/' + hex('7') + '/Images/Primary/../../../Users', 10, 10), /not a picture/);
    assert.strictEqual(jf.cleanUrl('https://x/hls1/main/3.ts?a=1&api_key=T&b=2'), 'https://x/hls1/main/3.ts?a=1&b=2');
});

test('drive gate: parked only on a fresh speed under 1 km/h with the selector in P; anything unknown is not parked', () => {
    const DG = require(path.join(APP, 'drivegate'));
    let t = 1000000;
    const g = DG.createGate({ now: () => t });
    assert.strictEqual(g.parked(), false, 'nothing known');
    g.stage('P');
    assert.strictEqual(g.parked(), false, 'no speed yet');
    g.speed({ speedVehicleCentreOfGravity: 0 });
    assert.strictEqual(g.parked(), true);
    g.speed({ speedVehicleCentreOfGravity: 65535 });             // "no value": the last real one stays, and ages
    assert.strictEqual(g.parked(), true);
    t += DG.STALE_MS + 1;
    assert.strictEqual(g.parked(), false, 'a speed that stopped arriving');
    g.speed({ speedVehicleCentreOfGravity: 64 * 30 });           // 30 km/h
    assert.strictEqual(g.parked(), false);
    assert.ok(/30\.0 km\/h/.test(g.why()), g.why());
    g.speed({ speedVehicleCentreOfGravity: 20 });                 // 0.3 km/h, but in D: a red light
    g.stage('D');
    assert.strictEqual(g.parked(), false, 'standing in D');
    g.stage('NP');
    assert.strictEqual(g.parked(), true, 'N or P, standing');
    g.speed({ speedVehicleCentreOfGravity: 64 * 3 });
    assert.strictEqual(g.parked(), false, 'N or P, rolling');
    assert.deepStrictEqual([DG.stageFromGearbox({ statusActualStageDrive: 1 }), DG.stageFromGearbox({ statusActualStageDrive: 'D' }), DG.stageFromGearbox({}),
        DG.stageFromSelection({ statusGearSelectionDrive: 3 }), DG.stageFromSelection({ statusGearSelectionDrive: 4 }), DG.stageFromSelection({ statusGearSelectionDrive: 2 })],
    ['P', 'D', undefined, 'P', 'NP', '2']);
    // a gate nothing feeds (no signals on this unit): never parked, and watch() does not throw
    assert.strictEqual(DG.watch(null, null, DG.createGate()).parked(), false);
});

test('drive gate: the picture while driving needs the setting AND the accepted disclaimer', () => {
    const DG = require(path.join(APP, 'drivegate'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
    const consent = DG.createConsent(path.join(dir, 'passenger.json'));
    const driving = DG.createGate(), parked = DG.createGate();
    driving.speed({ speedVehicleCentreOfGravity: 64 * 50 }); driving.stage('D');
    parked.speed({ speedVehicleCentreOfGravity: 0 }); parked.stage('P');
    assert.strictEqual(DG.pictureAllowed(parked, false, consent), true, 'parked');
    assert.strictEqual(DG.pictureAllowed(driving, false, consent), false, 'driving, setting off');
    assert.strictEqual(DG.pictureAllowed(driving, true, consent), false, 'driving, the setting on but the disclaimer not accepted');
    assert.strictEqual(consent.accept(), true);
    assert.strictEqual(DG.pictureAllowed(driving, false, consent), false, 'driving, the disclaimer accepted but the setting off');
    assert.strictEqual(DG.pictureAllowed(driving, true, consent), true, 'driving, both');
    assert.strictEqual(DG.pictureAllowed(driving, 'true', consent), false, 'the setting must be the boolean');
    // kept across a restart, gone when cleared, and only for the text it was given for
    assert.strictEqual(DG.createConsent(path.join(dir, 'passenger.json')).given(), true);
    consent.clear();
    assert.strictEqual(DG.pictureAllowed(driving, true, consent), false);
    assert.strictEqual(fs.existsSync(path.join(dir, 'passenger.json')), false);
    fs.writeFileSync(path.join(dir, 'passenger.json'), JSON.stringify({ accepted: true, version: DG.DISCLAIMER_VERSION + 1 }));
    assert.strictEqual(DG.createConsent(path.join(dir, 'passenger.json')).given(), false, 'another version of the text');
    // a gate that throws, a consent that throws: no picture
    assert.strictEqual(DG.pictureAllowed({ parked() { throw new Error('x'); } }, true, { given() { throw new Error('y'); } }), false);
    // a consent that cannot be written is not given
    assert.strictEqual(DG.createConsent(path.join(dir, 'no-such-folder', 'p.json')).accept(), false);
    assert.ok(DG.DISCLAIMER.join(' ').length > 300 && /passenger/.test(DG.DISCLAIMER[0]));
});

test('posters: a JPEG becomes exactly the pixels asked for, opaque', () => {
    const { cover } = require(path.join(SVC, 'art'));
    const jpg = fs.readFileSync(path.join(ROOT, 'tools', 'mock', 'posters', '01.jpg'));
    const px = cover(jpg, 148, 222);
    assert.strictEqual(px.length, 148 * 222 * 4);
    for (let i = 3; i < px.length; i += 4 * 97) assert.strictEqual(px[i], 255);
    assert.ok(px[0] + px[1] + px[2] > 30, 'the first pixel is not black');
    assert.strictEqual(cover(jpg, 300, 100).length, 300 * 100 * 4);       // another shape: cropped, not squeezed
    assert.throws(() => cover(Buffer.from('not a picture'), 10, 10), /not a JPEG/);
});

test('texts: times, and titles in letters the app\'s font has', () => {
    const U = require(path.join(APP, 'ui'));
    assert.deepStrictEqual([U.hms(0), U.hms(65), U.hms(3725), U.dur(2520), U.dur(5760), U.dur(7200)], ['0:00', '1:05', '1:02:05', '42 min', '1 h 36 min', '2 h ']);
    assert.strictEqual(U.clean('Amélie – Łódź 日本 “quoted”'), 'Amélie – Lódz  “quoted”');
    assert.strictEqual(U.epTag({ parentIndex: 2, index: 5 }), 'S2 E5');
});

test('player: a stream\'s bytes that arrive before its start are kept, an old stream\'s are dropped', async () => {
    const { createPlayer } = require(path.join(SVC, 'player'));
    const { PassThrough } = require('stream');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'player-'));
    const events = [];
    const pl = createPlayer({ bin: process.execPath, args: [path.join(ROOT, 'test', 'fake-player.js')], cwd: tmp, uid: null, videoPath: path.join(tmp, 'v'), env: { FAKE_SPEED: '200' },
        onEvent: (id, ev) => { if (ev.ev === 'end') events.push([id, ev.bytes]); } });
    const pipe = new PassThrough();
    pl.attach(pipe);
    const frame = (id, b) => { const h = Buffer.alloc(8); h.writeUInt32LE(id, 0); h.writeUInt32LE(b === null ? 0xffffffff : b.length, 4); return b === null ? h : Buffer.concat([h, b]); };
    // stream 1's bytes and its end, all before "start 1" is told
    pipe.write(frame(1, Buffer.alloc(30000, 1)));
    pipe.write(frame(1, Buffer.alloc(30000, 2)));
    pipe.write(frame(1, null));
    await sleep(50);
    pl.start(1);
    for (let i = 0; i < 100 && !events.length; i++) await sleep(50);
    assert.deepStrictEqual(events, [[1, 60000]]);
    // stream 3 is started; bytes still coming of stream 2 (left) are dropped, stream 3's are played
    pl.start(3);
    pipe.write(frame(2, Buffer.alloc(50000, 3)));
    pipe.write(frame(3, Buffer.alloc(40000, 4)));
    pipe.write(frame(3, null));
    for (let i = 0; i < 100 && events.length < 2; i++) await sleep(50);
    assert.deepStrictEqual(events[1], [3, 40000]);
    await pl.stopAll();
});

test('stand-in player: a real stream\'s seconds are read from its own time stamps (the emulator with a real server)', async () => {
    // MPEG-TS as a server sends it: 188-byte packets; a picture's packet begins a PES with its time (PTS, 90 kHz)
    const packet = (pts) => {
        const b = Buffer.alloc(188, 0xff);
        b[0] = 0x47; b[1] = pts === null ? 0x01 : 0x41; b[2] = 0x00; b[3] = 0x10;
        if (pts !== null) {
            Buffer.from([0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5,
                0x21 | ((Math.floor(pts / 1073741824) & 7) << 1), (pts >> 22) & 0xff, 0x01 | (((pts >> 15) & 0x7f) << 1), (pts >> 7) & 0xff, 0x01 | ((pts & 0x7f) << 1)]).copy(b, 4);
        }
        return b;
    };
    const parts = [];
    // twelve seconds of film that begins at its 100th second, a picture every half second, at some 300 kbit/s
    for (let i = 0; i <= 24; i++) { parts.push(packet(9000000 + i * 45000)); for (let k = 0; k < 100; k++) parts.push(packet(null)); }
    const child = spawn(process.execPath, [path.join(ROOT, 'test', 'fake-player.js')], { env: Object.assign({}, process.env, { FAKE_SPEED: '60' }), stdio: ['pipe', 'pipe', 'inherit', 'pipe'] });
    let out = '';
    const ended = () => out.split('\n').filter((l) => /"ev":"end"/.test(l) && /\}$/.test(l)).map((l) => JSON.parse(l.slice(4)))[0];
    child.stdout.on('data', (d) => { out += d; });
    child.stdin.on('error', () => {});
    child.stdin.end(Buffer.concat(parts));
    // (its "end" is waited for, not its exit: as the service does, which then ends it)
    for (let i = 0; i < 200 && !ended(); i++) await sleep(50);
    const end = ended();
    try { child.kill(); } catch (e) { /* gone */ }
    assert.ok(end, 'the player said no end: ' + out.slice(-300));
    near(end.t, 12, 0.01, 'the seconds played');           // (by bytes it would have been 23.7)
});

/* ---------------- the service ---------------- */

test('car audio: a route that fails is tried again at its own pace, not on every poll of the app, and said once', async () => {
    const { createCarAudio } = require(path.join(APP, 'caraudio'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drivefin-audio-'));
    let up = false, tries = 0, conns = [];
    const signals = {
        proxy: async (iface) => { if (!up) { tries++; throw new Error('no audio manager'); } return { iface }; },
        call: async (p, m, a) => {
            if (m === 'getListMainConnections') return conns.slice();
            if (m === 'connect') { conns.push({ mainConnectionID: 7, sourceID: a.sourceID, sinkID: a.sinkID }); return { amError: 'E_OK', mainConnectionID: 7 }; }
            if (m === 'disconnect') { conns = conns.filter((c) => c.mainConnectionID !== a.mainConnectionID); return { amError: 'E_OK' }; }
            return {};
        },
    };
    const said = [], log = { info: (s) => said.push('i ' + s), warn: (s) => said.push('w ' + s) };
    const RETRY = 400;
    const au = createCarAudio(signals, log, path.join(tmp, 'audio.json'), { retryMs: RETRY });
    // the app asks after every answer of the service, a few times a second: one attempt per retry time, however often
    const t0 = Date.now();
    for (let i = 0; i < 25; i++) { au.want(true); await sleep(2); }
    const polled = Date.now() - t0;
    assert.ok(tries >= 1 && tries <= 1 + Math.floor(polled / RETRY), tries + ' attempts for 25 polls in ' + polled + ' ms');
    await sleep(RETRY * 3);
    const all = Date.now() - t0;
    assert.ok(tries >= 3 && tries <= 2 + Math.floor(all / RETRY), 'tried again every ' + RETRY + ' ms: ' + tries + ' in ' + all + ' ms');
    assert.deepStrictEqual(said.filter((s) => s[0] === 'w'), ['w car audio: no audio manager'], 'the same failure is logged once');
    assert.strictEqual(au.state().error, 'no audio manager');
    up = true;
    await sleep(RETRY * 2);
    assert.deepStrictEqual([au.state().connected, au.state().error, conns.length], [true, null, 1]);
    for (let i = 0; i < 10; i++) { au.want(true); await sleep(4); }
    assert.strictEqual(conns.length, 1, 'connected once');
    au.want(false);
    await sleep(150);
    assert.deepStrictEqual([au.state().connected, conns.length], [false, 0]);
});

/** a stage signed in: the service knows the server, a Quick Connect code is asked for and entered */
async function linked(o) {
    const st = await createStage(Object.assign({ linked: false, filmSeconds: 40 }, o || {}));
    const cmd = (m) => st.svc.command(m);
    await cmd({ cmd: 'link-start' });
    await st.until(() => st.S.st && st.S.st.signin && st.S.st.signin.code, 5000, 'the code');
    st.mock.link();
    await st.until(() => st.S.connected(), 10000, 'the server');
    return { st, cmd, film: (title) => st.mock.find(title).Id };
}
const playing = (st) => st.until(() => st.S.pb() && st.S.pb().state === 'playing', 10000, 'playing');
const sessionsOf = (st) => Object.keys(st.mock.state.sessions);

test('service: the server\'s address, then Quick Connect; the token stays in a 0600 file and out of every answer and address', async () => {
    const st = await createStage({ linked: false, server: false });
    const cmd = (m) => st.svc.command(m);
    const sign = () => st.S.st.signin;
    let s = await cmd({ cmd: 'status' });
    assert.deepStrictEqual([s.account, s.client.state, s.signin.server, s.uplink.online], [null, 'signed-out', null, true]);
    // nothing is asked of a server before there is one
    await cmd({ cmd: 'link-start' });
    assert.strictEqual((await cmd({ cmd: 'status' })).signin.asking, false);
    // what is no address, and an address nothing answers at
    await cmd({ cmd: 'server', text: 'not an address!' });
    await st.until(() => sign().error && !sign().checking, 5000, 'the refusal');
    assert.ok(/not an address/.test(sign().error) && sign().server === null, sign().error);
    await cmd({ cmd: 'server', text: 'http://127.0.0.1:9' });
    assert.strictEqual((await cmd({ cmd: 'status' })).signin.checking, true);
    await st.until(() => sign().error && !sign().checking, 15000, 'no answer');
    assert.ok(/nothing answers|did not answer|cannot be reached/.test(sign().error), sign().error);
    // the server, typed without http: the port's plain http is found
    await cmd({ cmd: 'server', text: st.address });
    await st.until(() => sign().server, 8000, 'the server');
    assert.deepStrictEqual(sign().server, { url: st.mock.url, name: 'Jupiter', version: '10.11.0', quick: true, plain: true });
    assert.strictEqual(sign().error, null);
    // Quick Connect: six digits, good for ten minutes; nobody is signed in before they are entered
    await cmd({ cmd: 'link-start' });
    await st.until(() => sign().code, 5000, 'the code');
    assert.ok(/^\d{6}$/.test(sign().code), sign().code);
    assert.ok(sign().expires > Date.now() + 8 * 60000 && sign().expires < Date.now() + 11 * 60000);
    await st.settle(300);
    assert.strictEqual(st.S.signedIn(), false, 'signed in before the code was entered');
    st.mock.link();
    await st.until(() => st.S.connected(), 10000, 'connected');
    s = await cmd({ cmd: 'status' });
    assert.deepStrictEqual([s.account.user, s.client.server.name, s.client.server.version, s.client.server.host, s.signin.code], ['Driver', 'Jupiter', '10.11.0', '127.0.0.1', null]);
    const f = path.join(st.tmp, 'state', 'account.json');
    assert.deepStrictEqual([JSON.parse(fs.readFileSync(f, 'utf8')).token, JSON.parse(fs.readFileSync(f, 'utf8')).url], [TOKEN, st.mock.url]);
    if (process.platform !== 'win32') assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
    const home = await cmd({ cmd: 'home' });
    const all = JSON.stringify([s, home, await cmd({ cmd: 'meta', key: home.deck[0].key })]);
    assert.ok(all.indexOf(TOKEN) < 0, 'the token in an answer to the app');
    assert.strictEqual(st.mock.state.tokenInUrl, 0, 'the token in an address');
    // signing out deletes it here, and the server is told to drop it; the address stays for signing in again
    await cmd({ cmd: 'signout' });
    assert.strictEqual(fs.existsSync(f), false);
    s = await cmd({ cmd: 'status' });
    assert.deepStrictEqual([s.account, s.signin.server.url], [null, st.mock.url]);
    for (let i = 0; i < 40 && !st.mock.state.loggedOut; i++) await sleep(50);
    assert.strictEqual(st.mock.state.loggedOut, 1, 'the server was not told');
    // "other server" forgets the address too
    await cmd({ cmd: 'server-forget' });
    assert.strictEqual((await cmd({ cmd: 'status' })).signin.server, null);
    assert.strictEqual(fs.existsSync(path.join(st.tmp, 'state', 'server.json')), false);
    await st.close();
});

test('service: a server without Quick Connect takes a name and password, once; nothing keeps or logs the password', async () => {
    const st = await createStage({ linked: false, server: false });
    const cmd = (m) => st.svc.command(m);
    const sign = () => st.S.st.signin;
    await cmd({ cmd: 'server', text: st.address });
    await st.until(() => sign().server, 8000, 'the server');
    // Quick Connect is switched off on the server after its address was found: asking for a code says so
    st.mock.options.quick = false;
    await cmd({ cmd: 'link-start' });
    await st.until(() => sign().server.quick === false && !sign().asking, 5000, 'Quick Connect is off');
    assert.deepStrictEqual([sign().code, sign().error], [null, null]);
    // a name is needed; a wrong password says so, and signs nobody in
    await cmd({ cmd: 'login', user: '  ', password: PASSWORD });
    assert.ok(/user name/.test((await cmd({ cmd: 'status' })).signin.error));
    await cmd({ cmd: 'login', user: USER, password: 'a wrong one' });
    assert.strictEqual((await cmd({ cmd: 'status' })).signin.busy, true);
    await st.until(() => sign().error && !sign().busy, 5000, 'the refusal');
    assert.ok(/wrong name or password/.test(sign().error), sign().error);
    assert.strictEqual(st.S.signedIn(), false);
    await cmd({ cmd: 'login', user: USER.toLowerCase(), password: PASSWORD });
    await st.until(() => st.S.connected(), 10000, 'connected');
    const s = await cmd({ cmd: 'status' });
    assert.deepStrictEqual([s.account.user, s.signin.busy, s.signin.error], ['Driver', false, null]);
    assert.deepStrictEqual(st.mock.state.logins, [USER, USER.toLowerCase()]);
    // the password: not in the state folder, not in the log, not in an answer
    const kept = fs.readdirSync(path.join(st.tmp, 'state')).filter((n) => /\.json$/.test(n)).map((n) => fs.readFileSync(path.join(st.tmp, 'state', n), 'utf8')).join('\n');
    assert.ok(kept.indexOf(PASSWORD) < 0 && kept.indexOf('a wrong one') < 0, 'the password is kept');
    assert.ok(JSON.stringify(s).indexOf(PASSWORD) < 0 && JSON.stringify(s).indexOf('a wrong one') < 0, 'the password is in the status or the log');
    await st.close();
});

test('service: an older server (Jellyfin 10.8) is asked at its own addresses', async () => {
    const { st, cmd } = await linked({ mock: { legacy: true } });
    const home = await cmd({ cmd: 'home' });
    assert.deepStrictEqual(home.sections.map((x) => x.title + ':' + x.type), ['Movies:movie', 'TV Shows:show']);
    assert.ok(home.deck.length >= 3 && home.recent.length > 5 && !home.error, JSON.stringify(home).slice(0, 300));
    const key = st.mock.find('Paper Lanterns').Id;
    assert.deepStrictEqual(await cmd({ cmd: 'watched', key, on: true }), { key, on: true });
    assert.strictEqual(st.mock.state.played[key], true);
    const paths = st.mock.state.paths;
    ['GET /QuickConnect/Initiate', 'GET /Users/{id}/Views', 'GET /Users/{id}/Items/Resume', 'GET /Users/{id}/Items/Latest', 'POST /Users/{id}/PlayedItems/{id}'].forEach((p) => assert.ok(paths[p], 'never asked: ' + p));
    // each newer address was tried once, then left alone
    const before = st.mock.state.requests;
    await cmd({ cmd: 'watched', key, on: false });
    assert.strictEqual(st.mock.state.requests, before + 1, 'the newer address was tried again');
    await st.close();
});

test('service: the library, a show\'s seasons and episodes, search, a poster made once', async () => {
    const { st, cmd } = await linked();
    const home = await cmd({ cmd: 'home' });
    assert.deepStrictEqual(home.sections.map((x) => x.title + ':' + x.type), ['Movies:movie', 'TV Shows:show']);     // (the music library and the playlists are left out)
    // continue watching: what was begun, then the next episode of a show that has none begun
    assert.deepStrictEqual(home.deck.map((x) => (x.grandparentTitle || x.title) + (x.viewOffset ? '*' : '')), ['Harbor Lights*', 'Night Freight*', 'Under Glass*', 'Small Hours']);
    assert.ok(home.recent.length > 5 && home.recent.some((x) => x.type === 'show') && home.recent.some((x) => x.type === 'movie'));
    const movies = home.sections[0].key, tv = home.sections[1].key;
    const a = await cmd({ cmd: 'section', key: movies, type: 'movie', sort: 'title', start: 0, size: 5 });
    assert.strictEqual(a.total, 14); assert.strictEqual(a.items.length, 5);
    assert.strictEqual(a.items[0].title, 'The Cartographer\'s Daughter');
    const b = await cmd({ cmd: 'section', key: movies, type: 'movie', sort: 'title', start: 10, size: 5 });
    assert.strictEqual(b.items.length, 4);
    assert.ok((await cmd({ cmd: 'section', key: movies, type: 'movie', unwatched: true })).total < 14);
    assert.strictEqual((await cmd({ cmd: 'section', key: movies, type: 'movie', sort: 'year' })).items[0].year, 2024);
    const shows = await cmd({ cmd: 'section', key: tv, type: 'show' });
    const hl = shows.items.filter((x) => x.title === 'Harbor Lights')[0];
    assert.deepStrictEqual([hl.leafCount, hl.viewedLeafCount, hl.childCount], [16, 3, 2]);
    const seasons = await cmd({ cmd: 'children', key: hl.key });
    assert.deepStrictEqual(seasons.items.map((x) => x.type + x.index + ':' + x.viewedLeafCount + '/' + x.leafCount), ['season1:3/8', 'season2:0/8']);
    const eps = await cmd({ cmd: 'children', key: seasons.items[0].key, of: hl.key });
    assert.strictEqual(eps.items.length, 8);
    assert.deepStrictEqual([eps.items[3].type, eps.items[3].index, eps.items[3].parentIndex, eps.items[3].grandparentTitle, eps.items[3].viewOffset > 0, eps.items[0].viewCount], ['episode', 4, 1, 'Harbor Lights', true, 1]);
    assert.deepStrictEqual((await cmd({ cmd: 'search', q: 'light' })).items.map((x) => x.type + ':' + x.title), ['movie:Half Light', 'show:Harbor Lights']);
    const m = (await cmd({ cmd: 'meta', key: a.items[0].key })).item;
    assert.ok(m.media[0].audio.length === 2 && m.media[0].subtitles.length === 2 && m.summary.length > 20 && m.genres.length === 1);
    assert.deepStrictEqual(m.media[0].audio.map((x) => x.selected), [true, false]);
    const before = st.mock.state.requests;
    const p1 = await cmd({ cmd: 'art', path: m.thumb, w: 148, h: 222 });
    assert.strictEqual(Buffer.from(p1.img, 'base64').length, 148 * 222 * 4);
    // the server is asked for a JPEG of about twice the size
    assert.deepStrictEqual([st.mock.state.images[0].w, st.mock.state.images[0].h, st.mock.state.images[0].format], [296, 444, 'Jpg']);
    const mid = st.mock.state.requests;
    const p2 = await cmd({ cmd: 'art', path: m.thumb, w: 148, h: 222 });
    assert.strictEqual(p2.img, p1.img);
    assert.ok(mid > before && st.mock.state.requests === mid, 'the second one asked the server again');
    assert.strictEqual((await cmd({ cmd: 'art', path: 'http://elsewhere/x.jpg', w: 148, h: 222 })).none, true);
    assert.strictEqual((await cmd({ cmd: 'art', path: '/System/Info', w: 148, h: 222 })).none, true);
    assert.strictEqual((await cmd({ cmd: 'meta', key: hex('9') })).item, null);
    assert.strictEqual((await cmd({ cmd: 'meta', key: '../Users' })).version !== undefined, true, 'what is no key is no question');
    await cmd({ cmd: 'watched', key: m.key, on: true });
    assert.strictEqual(st.mock.state.played[m.key], true);
    assert.strictEqual(st.mock.state.tokenInUrl, 0, 'the token in an address');
    await st.close();
});

test('service: a film plays from where it was, pauses, skips and ends; the server is told', async () => {
    const { st, cmd, film } = await linked();
    await cmd({ cmd: 'prefs', gain: 9 });
    await cmd({ cmd: 'play', key: film('Night Freight'), offset: 24, quality: '720', audio: 2, subtitle: 3 });
    await playing(st);
    let p = st.S.pb();
    assert.deepStrictEqual([p.item.title, p.duration, p.quality, p.how, p.gain, p.audio, p.subtitle, p.subtitles], ['Night Freight', 40, '720', 'transcode', 9, 2, 3, true]);
    near(p.pos, 24, 6, 'the start');
    const sess = sessionsOf(st)[0], first = st.mock.state.sessions[sess];
    assert.strictEqual(first.info.StartTimeTicks, 240000000);
    assert.strictEqual(first.segments[0], 12, 'the first segment read is the one that holds 24 s');
    assert.deepStrictEqual([first.info.AudioStreamIndex, first.info.SubtitleStreamIndex, first.info.EnableDirectPlay, first.info.DeviceProfile.TranscodingProfiles[0].Protocol, first.info.MaxStreamingBitrate],
        [2, 3, false, 'hls', 4000000]);
    await cmd({ cmd: 'pause' });
    await st.until(() => st.S.pb().state === 'paused', 3000, 'paused');
    const at = st.S.pb().pos;
    await st.settle(400);
    near(st.S.pb().pos, at, 0.5, 'paused: the film stands');
    await cmd({ cmd: 'resume' });
    await playing(st);
    // a skip reads the same stream from another segment: the server is not asked for a new one
    await cmd({ cmd: 'seek', pos: 6 });
    await st.until(() => st.S.pb().state === 'playing' && st.S.pb().pos < 20, 8000, 'the skip');
    assert.deepStrictEqual([st.mock.state.playbackInfos, sessionsOf(st)], [1, [sess]]);
    assert.ok(first.segments.indexOf(3) > 0, 'the segment that holds 6 s was not read');
    await st.until(() => st.S.pb().state === 'ended', 10000, 'the end');
    assert.strictEqual(st.S.pb().pos, 40);
    // every byte of the stream reached the player: from the segment that holds 6 s (the fourth) to the last of 20
    const ends = st.S.st.log.map((l) => /"ev":"end".*"bytes":(\d+)/.exec(l)).filter(Boolean);
    assert.strictEqual(Number(ends[ends.length - 1][1]), 17 * 2 * 20000, 'the player did not get the whole stream');
    // the server heard of its start, of the pause, and of its end at the film's last second
    const r = st.mock.state.reports, last = r[r.length - 1];
    assert.deepStrictEqual([r[0].kind, r[0].key, r[0].session, r[0].audio, r[0].subtitle, r[0].method], ['start', film('Night Freight'), sess, 2, 3, 'Transcode']);
    near(r[0].time, 24, 0.01, 'the start told');
    assert.deepStrictEqual([last.kind, last.key, last.time, last.session], ['stopped', film('Night Freight'), 40, sess]);
    assert.strictEqual(r.filter((x) => x.kind === 'start').length, 1); assert.strictEqual(r.filter((x) => x.kind === 'stopped').length, 1);
    assert.ok(r.some((x) => x.kind === 'progress' && x.paused) && r.some((x) => x.kind === 'progress' && !x.paused));
    assert.strictEqual(st.mock.find('Night Freight').played, true, 'the server did not mark it watched');
    assert.strictEqual(sessionsOf(st).length, 0, 'a conversion left running on the server');
    assert.strictEqual(st.mock.state.tokenInUrl, 0, 'the token in an address (a playlist\'s, a segment\'s)');
    await st.close();
});

test('service: a server whose playlist starts at the offset plays from there too, and is asked anew for a skip', async () => {
    const { st, cmd, film } = await linked({ mock: { whole: false } });
    await cmd({ cmd: 'play', key: film('Night Freight'), offset: 24 });
    await playing(st);
    near(st.S.pb().pos, 24, 6, 'the start');
    assert.strictEqual(st.mock.state.sessions[sessionsOf(st)[0]].segments[0], 12);
    await cmd({ cmd: 'seek', pos: 10 });
    await st.until(() => st.S.pb().state === 'playing' && st.S.pb().pos < 22, 8000, 'the skip');
    assert.strictEqual(st.mock.state.playbackInfos, 2, 'the list has no segment before the first start: the server must be asked again');
    assert.strictEqual(sessionsOf(st).length, 1, 'the first conversion was left running');
    assert.strictEqual(st.mock.state.sessions[sessionsOf(st)[0]].segments[0], 5);
    await st.until(() => st.S.pb().state === 'ended', 10000, 'the end');
    await st.close();
});

test('service: an episode knows the next one, across a season\'s end; the next one keeps the sound and subtitles chosen', async () => {
    const { st, cmd, film } = await linked();
    const tv = (await cmd({ cmd: 'home' })).sections[1].key;
    const show = (await cmd({ cmd: 'section', key: tv, type: 'show' })).items.filter((x) => x.title === 'Harbor Lights')[0];
    const seasons = (await cmd({ cmd: 'children', key: show.key })).items;
    const s1 = (await cmd({ cmd: 'children', key: seasons[0].key, of: show.key })).items, s2 = (await cmd({ cmd: 'children', key: seasons[1].key, of: show.key })).items;
    const on = (key) => st.until(() => st.S.pb() && st.S.pb().item && st.S.pb().item.key === key && st.S.pb().state === 'playing', 10000, 'the episode');
    // French sound and German subtitles, chosen on the episode's page
    await cmd({ cmd: 'play', key: s1[2].key, offset: 0, audio: 2, subtitle: 4 });
    await st.until(() => st.S.pb() && st.S.pb().next, 8000, 'the next episode');
    assert.strictEqual(st.S.pb().next.key, s1[3].key);
    await on(s1[2].key);
    assert.deepStrictEqual([st.S.pb().audio, st.S.pb().subtitle], [2, 4]);
    // the next one, started with no word on its tracks (by itself, or from "continue watching"): the same languages
    await cmd({ cmd: 'play', key: s1[s1.length - 1].key, offset: 0 });
    await st.until(() => st.S.pb() && st.S.pb().item && st.S.pb().item.key === s1[s1.length - 1].key && st.S.pb().next, 8000, 'the next season');
    assert.strictEqual(st.S.pb().next.key, s2[0].key);
    await on(s1[s1.length - 1].key);
    assert.deepStrictEqual([st.S.pb().audio, st.S.pb().subtitle], [2, 4]);
    const info = st.mock.state.sessions[sessionsOf(st)[0]].info;
    assert.deepStrictEqual([info.AudioStreamIndex, info.SubtitleStreamIndex], [2, 4]);
    // subtitles switched off for an episode stay off for the next
    await cmd({ cmd: 'play', key: s2[0].key, offset: 0, audio: 1, subtitle: -1 });
    await on(s2[0].key);
    await cmd({ cmd: 'play', key: s2[s2.length - 1].key, offset: 0 });
    await on(s2[s2.length - 1].key);
    assert.deepStrictEqual([st.S.pb().audio, st.S.pb().subtitle, st.S.pb().subtitles], [1, -1, false]);
    await st.settle(300);
    assert.strictEqual(st.S.pb().next, null, 'the last episode of the last season has no next');
    // a film is none of that show's business: the server's own choice (its first sound, no subtitles)
    await cmd({ cmd: 'play', key: film('Half Light'), offset: 0 });
    await on(film('Half Light'));
    assert.deepStrictEqual([st.S.pb().audio, st.S.pb().subtitle, st.S.pb().next], [1, -1, null]);
    await cmd({ cmd: 'stop' });
    await st.until(() => st.S.pb().state === 'idle', 3000, 'stopped');
    await st.close();
});

test('service: a segment that fails is read again; a stream the server dropped is asked for anew where the film was', async () => {
    let fails = 0, dropped = false;
    const gone = {};
    const { st, cmd, film } = await linked({ retryForMs: 4000, mock: { segmentFail: (n, s) => {
        if (n === 3 && fails < 2) { fails++; return 500; }                           // twice, then fine
        // segment 9: the stream that first asks for it is gone for good (404), as a server that dropped a conversion
        if (n === 9 && (!dropped || gone[s.id])) { dropped = true; gone[s.id] = true; return 404; }
        return 0;
    } } });
    await cmd({ cmd: 'play', key: film('Night Freight'), offset: 0 });
    await st.until(() => st.S.pb().state === 'ended', 20000, 'the end');
    assert.strictEqual(fails, 2);
    assert.strictEqual(dropped, true);
    assert.strictEqual(st.mock.state.playbackInfos, 2, 'the server was not asked for a new stream');
    assert.ok(st.S.st.log.some((l) => /again from \d+ s/.test(l)), st.S.st.log.join('\n'));
    assert.strictEqual(st.S.pb().pos, 40);
    assert.strictEqual(st.mock.state.reports.filter((x) => x.kind === 'start').length, 1, 'a stream asked for anew is not another start of the film');
    await st.close();
});

test('service: a film the server refuses says why; a film that keeps failing gives up', async () => {
    const { st, cmd, film } = await linked({ retryForMs: 300, mock: { refuse: 'NotAllowed' } });
    await cmd({ cmd: 'play', key: film('Night Freight'), offset: 0 });
    await st.until(() => st.S.pb() && st.S.pb().state === 'error', 5000, 'the refusal');
    assert.ok(/may not play/.test(st.S.pb().error), st.S.pb().error);
    st.mock.options.refuse = null;
    st.mock.options.segmentFail = () => 404;
    const before = st.mock.state.playbackInfos;
    await cmd({ cmd: 'play', key: film('Paper Lanterns'), offset: 0 });
    await st.until(() => st.S.pb() && st.S.pb().item && st.S.pb().item.key === film('Paper Lanterns') && st.S.pb().state === 'error', 20000, 'giving up');
    assert.ok(st.mock.state.playbackInfos - before >= 4, 'it was not tried again');
    await st.close();
});

test('service: a sign-in the server no longer accepts leads back to signing in, at the same server', async () => {
    const mock = await createMock({ linked: true });
    // a service that starts with a token the server refuses
    const { createService } = require(path.join(SVC, 'service'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'refused-'));
    fs.mkdirSync(path.join(tmp, 'state'));
    fs.writeFileSync(path.join(tmp, 'state', 'account.json'), JSON.stringify({ url: mock.url, token: 'an-old-token', userId: USER_ID, user: 'Driver' }));
    const svc = createService({ stateDir: path.join(tmp, 'state'), uid: null, exit: false, leasePath: path.join(tmp, 'lease.json'),
        childEnv: { JFD_SYSTEM_DNS: '1', JFD_RETRY_MS: '100' }, playerBin: process.execPath, playerArgs: [path.join(ROOT, 'test', 'fake-player.js')], playerCwd: tmp });
    svc.start();
    let s = null;
    for (let i = 0; i < 100 && !(s && s.client.state === 'refused'); i++) { await sleep(50); s = await svc.command({ cmd: 'status' }); }
    assert.strictEqual(s.client.state, 'refused');
    assert.ok(/sign in again/.test(s.client.error), s.client.error);
    assert.strictEqual(s.signin.server.url, mock.url, 'the server to sign in at again');
    assert.ok((await svc.command({ cmd: 'home' })).error, 'the library was answered without a sign-in');
    // Quick Connect at that server again (the mock approves at once): a new token, connected
    await svc.command({ cmd: 'link-start' });
    for (let i = 0; i < 200 && s.client.state !== 'connected'; i++) { await sleep(50); s = await svc.command({ cmd: 'status' }); }
    assert.strictEqual(s.client.state, 'connected');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'account.json'), 'utf8')).token, TOKEN);
    svc.stop(0); await mock.close(); await sleep(100);
});

test('service: the film stops when the app stops asking (it was closed, or crashed)', async () => {
    const { st, cmd, film } = await linked({ filmSeconds: 4000, speed: 1, service: { watchMs: 600 } });
    await cmd({ cmd: 'play', key: film('Night Freight'), offset: 0 });
    await playing(st);
    await sleep(1500);                                   // nobody asks
    const s = await cmd({ cmd: 'status' });
    assert.ok(!s.playback || s.playback.state === 'idle', 'still ' + JSON.stringify(s.playback && s.playback.state));
    assert.ok(s.log.some((l) => /has not asked/.test(l)));
    await sleep(200);
    assert.strictEqual(sessionsOf(st).length, 0, 'the conversion was left running');
    const r = st.mock.state.reports;
    assert.strictEqual(r[r.length - 1].kind, 'stopped', 'the server was not told');
    await st.close();
});

test('service: a long film is read ahead of the player without running away (24 MiB or 90 s at most)', async () => {
    const { st, cmd, film } = await linked({ filmSeconds: 3000, speed: 1 });
    await cmd({ cmd: 'play', key: film('Night Freight'), offset: 0 });
    await playing(st);
    await st.settle(1500);
    const s = st.mock.state.sessions[sessionsOf(st)[0]];
    // the player holds 6 s and the reader 90 s more, 2 s a segment; the pipes between them hold a few more of
    // this film's tiny segments (40 kB each): some 50 to 70 segments, not all 1500
    assert.ok(s.segments.length >= 40 && s.segments.length <= 75, s.segments.length + ' segments were read');
    assert.ok(st.S.pb().ahead >= 80 && st.S.pb().ahead <= 92, 'ahead ' + st.S.pb().ahead);
    assert.strictEqual(st.S.pb().state, 'playing');
    await cmd({ cmd: 'stop' });
    await st.close();
});

/* ---------------- the app: its store and pages ---------------- */

/** types text on the sign-in page's keyboard by its keys, as a finger would */
function typeKeys(st, text) {
    const S = st.S;
    text.split('').forEach((c) => {
        st.frame();
        if (S.sign.kb.rows().every((r) => r.indexOf(c) < 0)) { st.tap('k_3_#layer'); st.frame(); }
        st.tap('k_' + S.sign.kb.rows().findIndex((r) => r.indexOf(c) >= 0) + '_' + c);
    });
    st.frame();
}

test('app: from the server\'s address to a film and back, by taps', async () => {
    const st = await createStage({ linked: false, server: false, filmSeconds: 200 });
    const S = st.S;
    await st.settle(200);
    assert.deepStrictEqual([S.page, S.signStep()], ['link', 'server']);
    let keys = st.frame().targets.map((t) => t.key);
    assert.ok(keys.indexOf('sv_go') >= 0 && keys.indexOf('k_0_q') >= 0 && keys.indexOf('k_3_#enter') >= 0, keys.join(' '));
    // "Connect" with nothing typed asks nothing
    st.tap('sv_go');
    assert.ok(/address/.test(S.toast.text));
    typeKeys(st, st.address);
    assert.strictEqual(S.sign.addr.value, st.address);
    st.tap('k_3_#enter');
    await st.until(() => S.signStep() === 'quick', 8000, 'the server');
    keys = st.frame().targets.map((t) => t.key);
    assert.deepStrictEqual(keys, ['ln_get', 'ln_pass', 'ln_other']);
    st.tap('ln_get');
    await st.until(() => S.st.signin.code, 5000, 'the code');
    assert.ok(st.frame().targets.some((t) => t.key === 'ln_cancel'));
    st.mock.link();
    await st.until(() => S.page === 'home' && S.home.at, 10000, 'home');
    const lib = (i) => 'rail_lib' + S.home.sections[i].key;
    keys = st.frame().targets.map((t) => t.key);
    ['rail_home', lib(0), lib(1), 'rail_search'].forEach((k) => assert.ok(keys.indexOf(k) >= 0, 'no ' + k + ' on the home page: ' + keys.join(' ')));
    assert.ok(keys.some((k) => /^deck_/.test(k)) && keys.some((k) => /^rec_/.test(k)));
    st.tap(lib(0));
    await st.until(() => S.lib && S.lib.items.length === 14, 5000, 'the films');
    // only what is on screen is drawn and can be tapped; the list scrolls
    keys = st.frame().targets.map((t) => t.key).filter((k) => /^li_/.test(k));
    assert.ok(keys.length >= 8 && keys.length <= 16, keys.length + ' posters can be tapped');
    assert.strictEqual(st.frame().cv.scroll, true);
    assert.strictEqual(st.ui.scroll(-50), false, 'scrolled above its top');
    assert.strictEqual(st.ui.scroll(50), true);
    assert.strictEqual(S.lib.scroll, 50);
    assert.strictEqual(st.ui.scroll(100000), true);
    assert.strictEqual(st.ui.scroll(10), false, 'scrolled below its end');
    st.tap('lib_sort'); st.frame();
    // a list to pick from is the only thing that takes taps
    keys = st.frame().targets.map((t) => t.key);
    assert.ok(keys.every((k) => /^pk_/.test(k)), keys.join(' '));
    st.tap('pk_2');
    await st.until(() => S.lib.sort === 'year' && S.lib.items.length === 14 && !S.picker, 5000, 'the new order');
    assert.strictEqual(S.lib.items[0].year, 2024);
    S.open(S.lib.items.filter((x) => x.title === 'Night Freight')[0]);
    await st.until(() => S.page === 'detail' && S.detail.item, 5000, 'the film\'s page');
    keys = st.frame().targets.map((t) => t.key);
    ['back', 'd_resume', 'd_start', 'd_seen', 'd_audio', 'd_subs'].forEach((k) => assert.ok(keys.indexOf(k) >= 0, 'no ' + k + ': ' + keys.join(' ')));
    // its tracks: the second sound, the first subtitles
    assert.strictEqual(S.detail.subtitle, null);
    st.tap('d_subs'); st.frame(); st.tap('pk_1');
    assert.strictEqual(S.detail.subtitle, '3');
    st.frame(); st.tap('d_audio'); st.frame(); st.tap('pk_1');
    assert.deepStrictEqual(S.detail.item.media[0].audio.map((a) => a.selected), [false, true]);
    st.frame(); st.tap('d_resume');
    assert.strictEqual(S.page, 'player');
    await st.until(() => S.pb() && S.pb().state === 'playing', 10000, 'playing');
    assert.deepStrictEqual([S.pb().subtitles, S.pb().audio, S.pb().subtitle], [true, 2, 3]);
    const info = st.mock.state.sessions[sessionsOf(st)[0]].info;
    assert.deepStrictEqual([info.AudioStreamIndex, info.SubtitleStreamIndex, info.AlwaysBurnInSubtitleWhenTranscoding], [2, 3, true]);
    S.overlayUntil = Date.now() + 5000;
    keys = st.frame().targets.map((t) => t.key);
    ['back', 'p_back10', 'p_play', 'p_fwd30', 'p_stop', 'p_pic'].forEach((k) => assert.ok(keys.indexOf(k) >= 0, 'no ' + k + ': ' + keys.join(' ')));
    assert.strictEqual(keys[keys.length - 1], 'p_pic', 'the picture\'s own target must come last: a tap goes to the first under the finger');
    assert.ok(st.ui.scrub && st.ui.scrub.dur === 200);
    st.tap('p_play');
    await st.until(() => S.pb().state === 'paused', 3000, 'paused');
    st.tap('p_stop');
    await st.until(() => !S.pb() || S.pb().state === 'idle', 3000, 'stopped');
    assert.strictEqual(S.page, 'detail');
    // back on its page, the sound chosen there is still the one chosen
    await st.until(() => S.detail.item && S.detail.item.viewOffset > 0, 5000, 'the film\'s page again');
    assert.deepStrictEqual(S.detail.item.media[0].audio.map((a) => a.selected), [false, true]);
    assert.strictEqual(S.back(), true); assert.strictEqual(S.page, 'library');
    assert.strictEqual(S.back(), true); assert.strictEqual(S.page, 'home');
    assert.strictEqual(S.back(), false, 'nothing before home: the HMI closes the screen');
    await st.close();
});

test('app: a name and password by taps; the password leaves the page when it is sent; "Other server" starts over', async () => {
    const st = await createStage({ linked: false, mock: { quick: false } });
    const S = st.S;
    await st.settle(200);
    assert.deepStrictEqual([S.page, S.signStep()], ['link', 'password']);
    let keys = st.frame().targets.map((t) => t.key);
    ['pw_user', 'pw_pass', 'pw_go', 'pw_other', 'k_3_#enter'].forEach((k) => assert.ok(keys.indexOf(k) >= 0, 'no ' + k + ': ' + keys.join(' ')));
    assert.ok(keys.indexOf('pw_quick') < 0, 'Quick Connect is offered though the server has it switched off');
    typeKeys(st, 'driver');
    st.tap('k_3_#enter');                                  // "Next": on to the password
    assert.strictEqual(S.sign.focus, 'pass');
    typeKeys(st, 'nope');
    assert.deepStrictEqual([S.sign.user.value, S.sign.pass.value], ['driver', 'nope']);
    st.tap('k_3_#enter');                                  // "Sign in"
    assert.strictEqual(S.sign.pass.value, '', 'the password stays on the page after it was sent');
    await st.until(() => S.st.signin.error && !S.st.signin.busy, 5000, 'the refusal');
    assert.ok(/wrong name or password/.test(S.st.signin.error));
    st.frame();
    typeKeys(st, PASSWORD);
    st.tap('pw_go');
    await st.until(() => S.page === 'home' && S.connected(), 10000, 'home');
    assert.deepStrictEqual([S.sign.user.value, S.sign.pass.value], ['', ''], 'what was typed is still on the sign-in page');
    assert.ok(/Signed in as Driver/.test(S.toast.text));
    // signing out, then another server: its address is asked for again, the old one ready to change
    S.signOut();
    await st.until(() => S.page === 'link' && !S.signedIn(), 5000, 'signed out');
    st.frame(); st.tap('pw_other');
    await st.until(() => S.signStep() === 'server', 5000, 'the address page');
    assert.strictEqual(S.sign.addr.value, st.mock.url);
    assert.ok(st.frame().targets.some((t) => t.key === 'sv_go'));
    await st.close();
});

test('app: driving, the picture is off unless the setting is on and its disclaimer was accepted while parked', async () => {
    const { st, film } = await linked({ filmSeconds: 4000, speed: 1 });
    const S = st.S;
    // how many times the player page asks for the film's picture when it is drawn now
    const video = () => {
        let n = 0;
        const real = require(path.join(ROOT, 'kit', 'runtime', 'record')).Recorder.prototype.video;
        const cv = new (require(path.join(ROOT, 'kit', 'runtime', 'record')).Recorder)(1600, 520, { textScale: 1.165 });
        cv.place = st.PLACE; cv.own = true; cv.extra = st.PLACE.extra;
        cv.video = function () { n++; return real.apply(this, arguments); };
        st.ui.drawPlayer(cv, { x: 33, y: 38, w: 1547, h: 523, bottom: 561, right: 1580 }, 569);
        return n;
    };
    S.play({ key: film('Night Freight') }, 0);
    await st.until(() => S.pb() && S.pb().state === 'playing', 10000, 'playing');
    st.car.parked = true;
    assert.strictEqual(video(), 1, 'parked: the picture');
    st.car.parked = false;
    assert.strictEqual(video(), 0, 'driving: no picture');
    st.frame();
    assert.ok(st.frame().targets.some((t) => t.key === 'p_play'), 'driving: the controls stay');
    st.values.motion = true;
    assert.strictEqual(video(), 0, 'driving, the setting on, no disclaimer accepted: no picture');
    // the disclaimer: not accepted on the move
    S.page = 'consent';
    assert.strictEqual(st.frame().targets.filter((t) => t.key === 'c_yes').length, 0, 'driving: "I understand" cannot be tapped');
    assert.ok(st.frame().targets.some((t) => t.key === 'c_no'));
    st.car.parked = true;
    st.frame(); st.tap('c_yes');
    assert.strictEqual(st.car.consent.given(), true);
    st.car.parked = false;
    S.page = 'player';
    assert.strictEqual(video(), 1, 'driving, the setting on and the disclaimer accepted: the picture');
    // "leave it off" switches the setting off again and forgets the consent
    S.page = 'consent'; st.frame(); st.tap('c_no');
    assert.deepStrictEqual([st.values.motion, st.car.consent.given()], [false, false]);
    S.page = 'player';
    assert.strictEqual(video(), 0);
    S.stop();
    await st.close();
});

test('app: the next episode starts by itself after a count, or not when the owner cancels', async () => {
    const { st } = await linked({ filmSeconds: 12 });
    const S = st.S;
    const tv = (await st.svc.command({ cmd: 'home' })).sections[1].key;
    const shows = await st.svc.command({ cmd: 'section', key: tv, type: 'show' });
    const seasons = (await st.svc.command({ cmd: 'children', key: shows.items[0].key })).items;
    const eps = (await st.svc.command({ cmd: 'children', key: seasons[0].key, of: shows.items[0].key })).items;
    S.play(eps[0], 0);
    await st.until(() => S.pb() && S.pb().state === 'ended', 10000, 'the end');
    assert.ok(S.nextAt > Date.now(), 'no count for the next episode');
    assert.ok(st.frame().targets.some((t) => t.key === 'p_nextnow') && st.frame().targets.some((t) => t.key === 'p_nextno'));
    st.tap('p_nextnow');
    await st.until(() => S.pb().item && S.pb().item.key === eps[1].key && S.pb().state === 'playing', 10000, 'the next episode');
    await st.until(() => S.pb().state === 'ended' && S.pb().item.key === eps[1].key, 10000, 'its end');
    st.frame(); st.tap('p_nextno');
    assert.strictEqual(S.nextAt, 0);
    await st.settle(400);
    assert.strictEqual(S.pb().item.key, eps[1].key, 'it started although cancelled');
    // with the setting off there is no count
    st.values.autoplay = false;
    S.play(eps[2], 0);
    await st.until(() => S.pb().state === 'ended' && S.pb().item.key === eps[2].key, 10000, 'the third\'s end');
    assert.strictEqual(S.nextAt, 0);
    await st.close();
});

test('app: every page draws, with the service missing, offline, loading and failing too', async () => {
    const st = await createStage({ linked: false, filmSeconds: 40 });
    const S = st.S;
    // no service at all
    S.st = null; S.svcErr = 'the Drivefin service is not installed'; S.svcErrCode = 'ENOSVC';
    assert.ok(st.frame().cv.words().length > 20);
    S.svcErr = null; S.svcErrCode = null;
    await st.settle(200);
    ['link', 'home', 'library', 'show', 'detail', 'search', 'player', 'consent'].forEach((p) => { S.page = p; st.frame(); });
    // signing in, each of its steps, with the head unit offline, an error to show and a sign-in the server refused
    S.page = 'link';
    const real = S.st;
    [null, { quick: true }, { quick: false }].forEach((srv) => [false, true].forEach((bad) => {
        S.st = JSON.parse(JSON.stringify(real));
        S.st.signin.server = srv && { url: 'http://' + 'very-long-name.'.repeat(12) + 'example', name: 'N'.repeat(90), version: '10.11.0', quick: srv.quick, plain: true };
        if (bad) { S.st.uplink = { online: false }; S.st.signin.error = 'E'.repeat(300); S.st.client = { state: 'refused', error: 'refused '.repeat(30) }; S.st.signin.checking = !srv; S.st.signin.busy = !!srv; }
        S.sign.addr.value = 'a'.repeat(120); S.sign.pass.value = 'p'.repeat(120);
        assert.ok(st.frame().cv.words().length > 20);
        S.sign.password = true; st.frame(); S.sign.password = false;
    }));
    S.sign.addr.value = ''; S.sign.pass.value = '';
    S.st = real;
    st.mock.link(); S.linkStart();
    await st.until(() => S.connected() && S.home.at, 10000, 'home');
    S.openLibrary(S.home.sections[1]);
    await st.until(() => S.lib.items.length, 5000, 'the shows');
    S.open(S.lib.items[2]);
    await st.until(() => S.show && S.show.seasons.length, 5000, 'the seasons');
    assert.ok(st.frame().targets.some((t) => t.key === 'sh_season'));
    st.tap('sh_season'); st.frame(); st.tap('pk_1');
    await st.until(() => S.show.sel === 1 && S.show.episodes[S.show.seasons[1].key].items, 5000, 'the second season');
    assert.strictEqual(S.show.episodes[S.show.seasons[1].key].items.length, 8);
    S.top('search'); st.frame();
    'kiln'.split('').forEach((c) => st.tap('k_' + [0, 1, 2].filter((r) => S.search.kb.rows()[r].indexOf(c) >= 0)[0] + '_' + c));
    assert.strictEqual(S.search.field.value, 'kiln');
    st.tap('k_3_#enter');
    await st.until(() => S.search.results && S.search.results.length === 1, 5000, 'the search');
    st.frame(); st.tap('sr_' + S.search.results[0].key);
    await st.until(() => S.page === 'show' && S.show.seasons.length, 5000, 'the show found');
    // a title in letters the font does not have, a very long one, no summary: still drawn
    S.detail = { key: hex('1'), loading: false, error: null, subtitle: null, item: { key: hex('1'), type: 'movie', title: '日本語 ' + 'W'.repeat(300), duration: 0, viewOffset: 0, viewCount: 0, media: [], genres: [] } };
    S.page = 'detail'; st.frame();
    S.page = 'home';
    S.picker = { title: 'x'.repeat(200), rows: Array.from({ length: 40 }, (_, i) => ({ label: 'row ' + i, on: i === 3, run() {} })) };
    assert.ok(st.frame().targets.length <= 12, 'a long list to pick from runs off the screen');
    S.picker = null;
    await st.close();
});

/* ---------------- main.js on a stand-in head unit ---------------- */

test('main.js: starts on a stand-in head unit from the staged package; the wheel, the speakers, the disclaimer', async () => {
    const py = ['python3', 'python'].filter((p) => { try { const r = spawnSync(p, ['--version'], { encoding: 'utf8' }); return r.status === 0 && /Python 3/.test(r.stdout + r.stderr); } catch (e) { return false; } })[0];
    if (!py) { print('     (skipped: no Python 3 for the kit\'s build)'); return; }
    // the kit's build needs an SDK folder: a clearly marked stand-in, never loaded here and refused by a car build
    const sdk = path.join(ROOT, 'oap-sdk');
    if (!fs.existsSync(path.join(sdk, 'index.js'))) {
        fs.mkdirSync(sdk);
        fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: 'oap-sdk', version: '0.0.0-pc-placeholder', description: 'NOT BMW\'s SDK: an empty stand-in so the kit\'s build can stage the app on a PC.' }, null, 2) + '\n');
        fs.writeFileSync(path.join(sdk, 'index.js'), '\'use strict\';\n// NOT BMW\'s SDK: an empty stand-in so the kit\'s build can stage the app on a PC (which never loads it).\nthrow new Error(\'oap-sdk PC placeholder\');\n');
    }
    const b = spawnSync(py, [path.join(ROOT, 'kit', 'tools', 'build.py'), 'clucraft_jellyfin'], { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(b.status, 0, 'the kit\'s build failed:\n' + b.stdout + b.stderr);
    const JS = path.join(ROOT, 'dist', 'clucraft_jellyfin', 'source', 'javascript');
    ['app.js', 'store.js', 'ui.js', 'svc.js', 'drivegate.js', 'caraudio.js', 'fullview.js', 'keyboard.js', 'qrcodegen.js', 'fonts.pack', path.join('kit', 'fullscreen.js')]
        .forEach((f) => assert.ok(fs.existsSync(path.join(JS, f)), 'the package has no ' + f));

    // the service on a local port, for the package's own svc.js
    const { st } = await linked({ filmSeconds: 4000, speed: 1 });
    const server = net.createServer();
    st.svc.serve(server);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    process.env.JFD_SOCK = String(server.address().port);
    const VIDEO = '/dev/shm/mgu-video-clucraft-jellyfin';

    // the head unit: what main.js asks of the kit
    const EventEmitter = require('events');
    const logged = { error: [], warn: [], info: [] };
    const log = { info: (s) => logged.info.push(String(s)), warn: (s) => logged.warn.push(String(s)), error: (s) => logged.error.push(String(s)), debug() {} };
    const values = { motion: false, quality: '720', autoplay: true, wheel: true, gain: '6', signout: 'no' }, listeners = [];
    const settings = { get: (k) => values[k], set(k, v) { values[k] = v; listeners.forEach((fn) => fn(k, v)); }, onChange(fn) { listeners.push(fn); } };
    // the car's audio manager: it keeps the connections it was asked for
    const watched = {}, calls = [];
    let mains = [], mainId = 41;
    const signals = {
        watch(iface, inst, handlers) { watched[iface] = handlers; return Promise.resolve({ available: true }); },
        proxy(iface) { return Promise.resolve({ iface }); },
        call(p, method, params) {
            calls.push({ iface: p.iface, method, params });
            if (method === 'getListMainConnections') return Promise.resolve(mains.slice());
            if (method === 'connect') { mains.push({ mainConnectionID: ++mainId, sourceID: params.sourceID, sinkID: params.sinkID }); return Promise.resolve({ amError: 'E_OK', mainConnectionID: mainId }); }
            if (method === 'disconnect') mains = mains.filter((c) => c.mainConnectionID !== params.mainConnectionID);
            return Promise.resolve({ amError: 'E_OK' });
        },
    };
    const record = require(path.join(JS, 'kit', 'record'));
    class Gpu extends EventEmitter {
        constructor() { super(); this.ready = true; this.native = true; this.touch = true; this.info = { video: true, touch: true, controller: true }; this.visible = true; this.videos = []; this.frames = 0; this.waiting = false; }
        connect() { setImmediate(() => this.emit('ready')); return this; }
        place() {} claim() {} grab() {} close() {}
        show(v) { this.visible = !!v; }
        video(id, file) { this.videos.push([id, file]); return true; }
        frame() { this.frames++; }
    }
    const gpu = new Gpu(), fullGpus = [];
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-data-'));
    let loopFn = null, backFn = null, scrollFn = null, touchFn = null, lastCv = null, sheetClosed = 0;
    const clicks = {};
    const ctx = {
        log, settings, signals, dataDir,
        ui: { onClick(n, fn) { clicks[n] = fn; }, isVisible: (n) => n === 'MAIN', hasFocus: () => true, onVisible() {}, image(n, cv) { lastCv = cv; return Promise.resolve(); } },
        display: { gpu, place: st.PLACE, closeSheet() { sheetClosed++; }, _syncVisible() { gpu.visible = true; } },
        canvas(w, h) { const cv = new record.Recorder(w, h, { textScale: st.PLACE.scale }); cv.place = st.PLACE; cv.own = true; cv.extra = st.PLACE.extra; cv.chrome = null; return cv; },
        loop(name, fps, fn) { loopFn = fn; return { stop() {} }; },
        theme: () => ({}), hideButton() {},
        onTouch(fn) { touchFn = fn; }, onBack(fn) { backFn = fn; }, onScroll(fn) { scrollFn = fn; },
    };
    let impl = null;
    const realLoad = Module._load;
    Module._load = function (req, parent) {
        if (parent && parent.filename && parent.filename.indexOf(JS) === 0 && parent.filename.indexOf(path.join(JS, 'kit')) !== 0) {
            if (req === './kit/mgu') return { run(i) { impl = i; } };
            if (req === './kit/renderd') return { RenderClient: class extends Gpu { constructor() { super(); fullGpus.push(this); } } };
        }
        return realLoad.apply(this, arguments);
    };
    // the player's frame file "exists" once a film plays: main.js looks for it at its fixed place
    const realStat = fs.statSync;
    let videoFile = false;
    fs.statSync = function (p) { if (p === VIDEO) { if (!videoFile) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { ino: 77 }; } return realStat.apply(fs, arguments); };
    try {
        require(path.join(JS, 'app.js'));
        assert.ok(impl && typeof impl.start === 'function', 'main.js did not hand the kit its start');
        await impl.start(ctx);
        assert.ok(loopFn && backFn && scrollFn && touchFn, 'main.js did not take the loop, back, scroll and touch');
        ['BTN_HOME', 'BTN_NOW', 'BTN_PLAYPAUSE', 'BTN_STOP'].forEach((n) => assert.ok(clicks[n], 'no handler for ' + n));
        assert.ok(watched['de.bmw.infotainment.vehicle.Vehicle2'] && watched['de.bmw.infrastructure.VehicleInformation'], 'the drive gate does not watch the car');
        const speed = (kmh) => watched['de.bmw.infotainment.vehicle.Vehicle2'].statusCarSpeed2({ speedVehicleCentreOfGravity: Math.round(kmh * 64) });
        const gear = (g) => watched['de.bmw.infrastructure.VehicleInformation'].statusGearboxDrive({ statusActualStageDrive: g });
        const frames = async (ms) => { const t = Date.now() + ms; while (Date.now() < t) { await loopFn(); await sleep(60); } };
        const tap = (key) => { const t = lastCv.targets.filter((x) => x.key === key)[0]; assert.ok(t, 'no target ' + key + ' (' + lastCv.targets.map((x) => x.key).join(' ') + ')'); t.run(); };
        speed(0); gear('P');
        await frames(2500);                                           // the status, home, its posters
        assert.ok(lastCv.targets.some((t) => /^rail_lib/.test(t.key)), 'not on the home page: ' + lastCv.targets.map((t) => t.key).join(' '));
        assert.ok(lastCv.targets.some((t) => /^deck_/.test(t.key)), 'no "continue watching"');
        assert.strictEqual(scrollFn(100), false, 'the home page does not scroll');

        // a film from "continue watching": the player goes over the whole screen, the speakers are asked for
        tap(lastCv.targets.filter((t) => /^deck_/.test(t.key))[0].key);
        videoFile = true;
        await frames(2500);
        assert.strictEqual(fullGpus.length, 1, 'no second connection for the full view');
        assert.ok(fullGpus[0].frames > 3, 'the full view drew nothing');
        assert.strictEqual(gpu.visible, false, 'the page is not hidden under the full view');
        assert.ok(gpu.videos.length === 1 && fullGpus[0].videos.length === 1 && gpu.videos[0][1] === VIDEO, 'the video file was not named to the renderer');
        const con = calls.filter((c) => c.method === 'connect')[0];
        assert.ok(con && con.params.sourceID === 287 && con.params.sinkID === 1024, 'the sound was not routed to the speakers: ' + JSON.stringify(calls.map((c) => c.method)));
        let s = await st.svc.command({ cmd: 'status' });
        assert.strictEqual(s.playback.state, 'playing');
        const at = s.playback.pos;

        // the steering wheel's skip, on release: 30 s on
        const wheel = watched['de.bmw.infotainment.controlelements.SteeringWheelPushButton'].statusSearchSwitch1;
        wheel({ operationPushButtonAudioAutomaticTuningSteeringWheel: 'X_SKIP_RECHTS' });
        wheel({ operationPushButtonAudioAutomaticTuningSteeringWheel: 'KEINE_AKTION' });
        await frames(2500);
        s = await st.svc.command({ cmd: 'status' });
        assert.ok(s.playback.pos > at + 25, 'the wheel did not skip: ' + at + ' -> ' + s.playback.pos);

        // the controller on the full view: press pauses
        fullGpus[0].emit('ccu', { frontRotaryEncoderOperation: 10, frontRotaryEncoderPushButton: 0, frontRotaryEncoderDeflection: 0 });
        fullGpus[0].emit('ccu', { frontRotaryEncoderOperation: 10, frontRotaryEncoderPushButton: 1, frontRotaryEncoderDeflection: 0 });
        await frames(1200);
        assert.strictEqual((await st.svc.command({ cmd: 'status' })).playback.state, 'paused');
        assert.ok(calls.some((c) => c.method === 'disconnect') && mains.length === 0, 'paused: the speakers were not given back');
        clicks.BTN_PLAYPAUSE();
        await frames(1500);
        assert.strictEqual((await st.svc.command({ cmd: 'status' })).playback.state, 'playing');
        assert.strictEqual(mains.length, 1, 'playing again: the speakers were not asked for again');

        // "Video while driving" switched on in the settings: the disclaimer, not the picture
        backFn();                                                     // (the HMI's back: out of the player)
        await frames(300);
        speed(60); gear('D');
        settings.set('motion', true);
        await frames(300);
        assert.ok(sheetClosed >= 1, 'the settings sheet was not closed for the disclaimer');
        assert.ok(lastCv.targets.some((t) => t.key === 'c_no') && !lastCv.targets.some((t) => t.key === 'c_yes'), 'driving: the disclaimer can be accepted');
        assert.strictEqual(fs.existsSync(path.join(dataDir, 'passenger.json')), false);
        speed(0); gear('P');
        await frames(200);
        tap('c_yes');
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'passenger.json'), 'utf8')).accepted, true);
        assert.strictEqual(values.motion, true);
        settings.set('motion', false);                                // off again: the consent goes with it
        assert.strictEqual(fs.existsSync(path.join(dataDir, 'passenger.json')), false);
        settings.set('motion', true);
        await frames(200);
        tap('c_no');
        assert.strictEqual(values.motion, false);

        clicks.BTN_STOP();
        await frames(800);
        assert.strictEqual((await st.svc.command({ cmd: 'status' })).playback.state, 'idle');

        // "Sign out" in the settings: the sign-in page, at Quick Connect for the server it knows
        settings.set('signout', 'yes');
        await frames(1500);
        assert.strictEqual(values.signout, 'no', 'the setting did not go back to "signed in"');
        assert.strictEqual((await st.svc.command({ cmd: 'status' })).account, null);
        assert.ok(lastCv.targets.some((t) => t.key === 'ln_get'), 'not on the sign-in page: ' + lastCv.targets.map((t) => t.key).join(' '));
        assert.deepStrictEqual(logged.error, [], 'main.js logged errors');
        assert.ok(logged.info.some((l) => /^started 0\.1\.0/.test(l)), logged.info.join('\n'));
    } finally {
        Module._load = realLoad; fs.statSync = realStat; delete process.env.JFD_SOCK;
        server.close();
        await st.close();
    }
});

/* ---------------- the repository ---------------- */

test('emulator: what tools/emu.js changes in the kit is there to change, once', () => {
    const E = require(path.join(ROOT, 'tools', 'emu'));
    assert.ok(/^[0-9a-f]{40}$/.test(E.EMU_COMMIT), 'the emulator is pinned to a commit');
    assert.strictEqual(E.APP_ID, 'clucraft_jellyfin');
    // this repository's own file among them
    const mine = E.ADAPT.filter((a) => a[0] === 'kit/runtime/renderd.js');
    assert.strictEqual(mine.length, 1);
    assert.strictEqual(fs.readFileSync(path.join(ROOT, mine[0][0]), 'utf8').split(mine[0][2]).length, 2, 'renderd.js has the line once');
    // the kit's emulator files, when a checkout is at hand (npm run emu fetched one, or IDRIVE7_APPS names one)
    const kit = [process.env.IDRIVE7_APPS, path.join(ROOT, 'vendor', 'idrive7-apps')].filter(Boolean).find((d) => fs.existsSync(path.join(d, 'kit', 'tools', 'emu.js')));
    for (const [file, what, from, to] of E.ADAPT) {
        assert.ok(from !== to && to.length > from.length - 40 && what, file);
        if (!kit || file === 'kit/runtime/renderd.js') continue;
        assert.strictEqual(fs.readFileSync(path.join(kit, file), 'utf8').replace(/\r\n/g, '\n').split(from).length, 2, file + ': ' + what);
    }
    // the app and its backend find each other by a port, and the stand-in SDK says what it is
    const src = fs.readFileSync(path.join(ROOT, 'tools', 'emu.js'), 'utf8');
    assert.ok(/JFD_SOCK: backendPort/.test(src) && /NOT BMW's SDK/.test(src));
});

test('repository: the versions and manifests agree; nothing of BMW\'s and no account is in it', () => {
    const j = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    const app = j('apps/clucraft_jellyfin/app.json'), comp = j('native/clucraft-jellyfin/component.json'), repo = j('mgu-repo.json'), pkg = j('package.json');
    const ver = (f, re) => (re.exec(fs.readFileSync(path.join(ROOT, f), 'utf8')) || [])[1];
    assert.strictEqual(ver('apps/clucraft_jellyfin/main.js', /const VERSION = '([\d.]+)'/), app.version, 'main.js and app.json');
    assert.strictEqual(ver('native/clucraft-jellyfin/service.js', /const VERSION = '([\d.]+)'/), comp.version, 'service.js and component.json');
    assert.strictEqual(app.requires['clucraft-jellyfin'], comp.version, 'the app asks for another service version');
    assert.strictEqual(pkg.version, app.version);
    assert.strictEqual(repo.apps.manifest, 'app.json');
    assert.deepStrictEqual(repo.components.map((c) => c.id + ':' + c.path), ['clucraft-jellyfin:native/clucraft-jellyfin']);
    comp.files.concat(comp.units).forEach((f) => assert.ok(fs.existsSync(path.join(ROOT, 'native/clucraft-jellyfin', f.from)), 'component.json names ' + f.from + ', which is not there'));
    // every script of the tool is in its manifest (a file left out would be missing on the car)
    fs.readdirSync(path.join(ROOT, 'native/clucraft-jellyfin')).filter((f) => /\.js$/.test(f)).forEach((f) => assert.ok(comp.files.some((x) => x.from === f), f + ' is not in component.json'));
    assert.deepStrictEqual(comp.uids, [ver('native/clucraft-jellyfin/service.js', /const NET_UID = (\d+)/)].map(Number));
    // the names the app and the service find each other by are the same on both sides
    const sock = ver('apps/clucraft_jellyfin/svc.js', /'(\/run\/[a-z-]+\.sock)'/), video = ver('apps/clucraft_jellyfin/main.js', /VIDEO_FILE = '([^']+)'/);
    assert.strictEqual(sock, '/run/' + comp.id + '.sock');
    [['native/clucraft-jellyfin/service.js', sock], ['native/clucraft-jellyfin/sockgroup.js', sock], ['native/clucraft-jellyfin/systemd/clucraft-jellyfin.socket', sock], ['native/clucraft-jellyfin/player.js', video],
        ['native/clucraft-jellyfin/sockgroup.js', '\'' + app.id + '\'']].forEach((x) => assert.ok(fs.readFileSync(path.join(ROOT, x[0]), 'utf8').indexOf(x[1]) >= 0, x[0] + ' does not name ' + x[1]));
    assert.ok(app.settings.filter((s) => s.key === 'motion')[0].default === false, 'video while driving must be off by default');
    // what must never be committed
    const ignored = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    ['/oap-sdk/', 'dist/'].forEach((p) => assert.ok(ignored.indexOf(p) >= 0, '.gitignore does not name ' + p));
    const sources = [];
    const walk = (d) => fs.readdirSync(d).forEach((f) => { const p = path.join(d, f); if (/^(\.git|node_modules|dist|oap-sdk|\.cache|vendor)$/.test(f)) return; if (fs.statSync(p).isDirectory()) walk(p); else if (/\.(js|json|md|service|socket)$/.test(f)) sources.push(p); });
    walk(ROOT);
    sources.filter((p) => p !== __filename).forEach((p) => {
        const t = fs.readFileSync(p, 'utf8');
        assert.ok(!/(api_key|ApiKey)=[0-9a-f]{20,}/.test(t) && !/Token="[0-9a-f]{20,}"/.test(t), path.relative(ROOT, p) + ' holds a token');
        assert.ok(!/isParked\(\)\s*\{[^}]*return true;/.test(t) && !/FORCES "PARKED"/.test(t), path.relative(ROOT, p) + ' forces "parked"');
    });
});

/* ---------------- run ---------------- */
(async () => {
    const only = process.argv[2];
    let failed = 0, ran = 0;
    for (const t of tests) {
        if (only && t.name.indexOf(only) < 0) continue;
        ran++;
        const t0 = Date.now();
        try { await t.fn(); print('ok   ' + t.name + '  (' + (Date.now() - t0) + ' ms)'); }
        catch (e) { failed++; print('FAIL ' + t.name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 8).join('\n     ')); }
    }
    print('\n' + (ran - failed) + ' of ' + ran + ' passed on Node ' + process.version);
    setTimeout(() => process.exit(failed ? 1 : 0), 200);
})();
