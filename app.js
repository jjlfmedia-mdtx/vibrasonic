'use strict';

/* ===================================================================
   VibraSonic — Reproductor de música
   =================================================================== */

/* ===== IndexedDB (persistencia de canciones) ===== */
const idb = {
    db: null,
    async init() {
        return new Promise((resolve) => {
            const req = indexedDB.open('vibrasonic', 1);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('songs')) db.createObjectStore('songs');
            };
            req.onsuccess = (e) => { this.db = e.target.result; resolve(); };
            req.onerror = () => resolve();
        });
    },
    put(key, val) {
        return new Promise((resolve) => {
            if (!this.db) return resolve();
            const tx = this.db.transaction('songs', 'readwrite');
            tx.objectStore('songs').put(val, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    },
    getAll() {
        return new Promise((resolve) => {
            if (!this.db) return resolve([]);
            const tx = this.db.transaction('songs', 'readonly');
            const store = tx.objectStore('songs');
            const result = [];
            const req = store.openCursor();
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) { result.push({ key: cursor.key, value: cursor.value }); cursor.continue(); }
                else resolve(result);
            };
            req.onerror = () => resolve([]);
        });
    },
    delete(key) {
        return new Promise((resolve) => {
            if (!this.db) return resolve();
            const tx = this.db.transaction('songs', 'readwrite');
            tx.objectStore('songs').delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    },
};

/* ===== State ===== */
const state = {
    library: [],
    playlists: [],
    favorites: [],
    currentSongId: null,
    currentList: [],
    currentIndex: -1,
    isPlaying: false,
    shuffle: false,
    repeat: 'off',
    currentView: 'library',
    currentPlaylistId: null,
    lyrics: [],
    vizMode: 'bars',
    pendingPlaylistSongId: null,
    contextSongId: null,
    lyricsForSongId: null,
    djMode: false,
    djPlaylist: [],
    crossfadeSec: 8,
    theme: 'light',
    volume: 0.8,
    crossfading: false,
    loadingFromDB: false,
};

/* ===== DOM ===== */
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

/* ===== Two-Deck Audio ===== */
const deckA = new Audio();
const deckB = new Audio();
deckA.preload = 'metadata';
deckB.preload = 'metadata';
deckA.crossOrigin = 'anonymous';
deckB.crossOrigin = 'anonymous';

let audio = deckA;
let activeDeckId = 'A';
let audioCtx = null, analyser = null;
let gainA = null, gainB = null;
let graphReady = false;
let dataArray = null;

function ensureGraph() {
    if (graphReady) return;
    try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        gainA = audioCtx.createGain();
        gainB = audioCtx.createGain();
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.82;
        dataArray = new Uint8Array(analyser.frequencyBinCount);

        const srcA = audioCtx.createMediaElementSource(deckA);
        const srcB = audioCtx.createMediaElementSource(deckB);
        srcA.connect(gainA); srcB.connect(gainB);
        gainA.connect(analyser); gainB.connect(analyser);
        analyser.connect(audioCtx.destination);
        gainA.gain.value = state.volume;
        gainB.gain.value = 0;

        [deckA, deckB].forEach(d => {
            d.addEventListener('timeupdate', onTimeUpdate);
            d.addEventListener('loadedmetadata', onLoadedMetadata);
            d.addEventListener('play', onPlay);
            d.addEventListener('pause', onPause);
            d.addEventListener('ended', onEnded);
        });
        graphReady = true;
    } catch (e) {
        console.error('Audio graph error', e);
        [deckA, deckB].forEach(d => {
            d.addEventListener('timeupdate', onTimeUpdate);
            d.addEventListener('loadedmetadata', onLoadedMetadata);
            d.addEventListener('play', onPlay);
            d.addEventListener('pause', onPause);
            d.addEventListener('ended', onEnded);
        });
        graphReady = true;
    }
}

function getActiveGain() { return activeDeckId === 'A' ? gainA : gainB; }
function getInactiveGain() { return activeDeckId === 'A' ? gainB : gainA; }
function getInactiveDeck() { return activeDeckId === 'A' ? deckB : deckA; }

function setMasterVolume(v) {
    state.volume = v;
    if (graphReady && getActiveGain() && !state.crossfading) getActiveGain().gain.value = v;
    if (!graphReady) audio.volume = v;
    localStorage.setItem('vs_volume', v);
}

/* ===== Persistence (localStorage for meta) ===== */
function saveState() {
    try {
        const data = {
            playlists: state.playlists,
            favorites: state.favorites,
            theme: state.theme,
        };
        localStorage.setItem('vs_data', JSON.stringify(data));
    } catch (e) {}
}

function loadState() {
    try {
        const data = JSON.parse(localStorage.getItem('vs_data') || '{}');
        if (data.playlists) state.playlists = data.playlists;
        if (data.favorites) state.favorites = data.favorites;
        if (data.theme) state.theme = data.theme;
    } catch (e) {}
}

/* ===== Toast ===== */
let toastTimer;
function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

/* ===== ID3 Parser with FIXED encoding ===== */
function parseID3Tags(buffer) {
    const result = { title: '', artist: '', album: '', artUrl: null };
    try {
        const bytes = new Uint8Array(buffer);
        if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
            return tryID3v1(bytes, result);
        }
        const ver = bytes[3];
        const flag = bytes[5];
        let size = (bytes[6] & 0x7f) * 0x200000 + (bytes[7] & 0x7f) * 0x4000 + (bytes[8] & 0x7f) * 0x80 + (bytes[9] & 0x7f);
        let offset = 10;
        if (flag & 0x40) {
            let extSize = ver === 4
                ? (bytes[10] & 0x7f) * 0x200000 + (bytes[11] & 0x7f) * 0x4000 + (bytes[12] & 0x7f) * 0x80 + (bytes[13] & 0x7f)
                : (bytes[10] << 24) | (bytes[11] << 16) | (bytes[12] << 8) | bytes[13];
            offset += extSize;
        }
        const end = 10 + size;
        while (offset < end - 10) {
            const fid = String.fromCharCode(bytes[offset], bytes[offset+1], bytes[offset+2], bytes[offset+3]);
            if (fid.charCodeAt(0) === 0) break;
            let fs = ver === 4
                ? (bytes[offset+4]&0x7f)*0x200000+(bytes[offset+5]&0x7f)*0x4000+(bytes[offset+6]&0x7f)*0x80+(bytes[offset+7]&0x7f)
                : (bytes[offset+4]<<24)|(bytes[offset+5]<<16)|(bytes[offset+6]<<8)|bytes[offset+7];
            offset += 10;
            if (fs <= 0 || offset + fs > end) break;
            const fd = bytes.subarray(offset, offset + fs);
            if (fid === 'TIT2') result.title = decodeText(fd);
            else if (fid === 'TPE1') result.artist = decodeText(fd);
            else if (fid === 'TALB') result.album = decodeText(fd);
            else if (fid === 'APIC') { const p = decodeAPIC(fd); if (p) result.artUrl = p; }
            offset += fs;
        }
    } catch (e) { console.warn('ID3 error', e); }
    return result;
}

function tryID3v1(bytes, result) {
    try {
        const off = bytes.length - 128;
        if (off < 0) return result;
        if (bytes[off] !== 0x54 || bytes[off+1] !== 0x41 || bytes[off+2] !== 0x47) return result;
        result.title = safeDecode(bytes.subarray(off+3, off+33)).trim().replace(/\0/g,'');
        result.artist = safeDecode(bytes.subarray(off+33, off+63)).trim().replace(/\0/g,'');
        result.album = safeDecode(bytes.subarray(off+63, off+93)).trim().replace(/\0/g,'');
    } catch(e) {}
    return result;
}

/* Decode ID3v2 text frame: first byte = encoding */
function decodeText(frameData) {
    const enc = frameData[0];
    const tb = frameData.subarray(1);
    if (enc === 3) return new TextDecoder('utf-8').decode(tb).replace(/\0+$/,'').trim();
    if (enc === 1) { try { return new TextDecoder('utf-16').decode(tb).replace(/\0+$/,'').trim(); } catch(e){} }
    if (enc === 2) { try { return new TextDecoder('utf-16be').decode(tb).replace(/\0+$/,'').trim(); } catch(e){} }
    // enc 0 or fallback: try UTF-8, then Windows-1252
    return safeDecode(tb).replace(/\0+$/,'').trim();
}

/* FIXED: UTF-8 first, then Windows-1252 (NOT GBK/Big5 which caused Chinese) */
function safeDecode(bytes) {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch(e) {
        return new TextDecoder('windows-1252').decode(bytes);
    }
}

function decodeAPIC(frameData) {
    try {
        const enc = frameData[0];
        let i = 1;
        let me = i;
        while (frameData[me] !== 0 && me < frameData.length) me++;
        const mime = new TextDecoder('iso-8859-1').decode(frameData.subarray(i, me));
        i = me + 1 + 1;
        if (enc === 1 || enc === 2) { while (i < frameData.length-1 && !(frameData[i]===0 && frameData[i+1]===0)) i+=2; i+=2; }
        else { while (frameData[i] !== 0 && i < frameData.length) i++; i++; }
        const picData = frameData.subarray(i);
        const blob = new Blob([picData], { type: mime || 'image/jpeg' });
        return URL.createObjectURL(blob);
    } catch(e) { return null; }
}

/* ===== File Handling ===== */
async function handleFiles(files) {
    let audioFiles = [];
    let lrcFiles = [];
    for (const file of files) {
        if (file.name.toLowerCase().endsWith('.lrc')) lrcFiles.push(file);
        else if (file.type.startsWith('audio/') || /\.(mp3|flac|wav|m4a|aac|ogg|opus)$/i.test(file.name)) audioFiles.push(file);
    }
    if (audioFiles.length === 0 && lrcFiles.length === 0) { toast('No se reconocieron archivos de audio'); return; }

    toast(`Cargando ${audioFiles.length} canción${audioFiles.length !== 1 ? 'es' : ''}...`);

    for (const file of audioFiles) {
        try {
            const url = URL.createObjectURL(file);
            const tags = await extractMetadata(file);
            const artBlob = tags.artUrl ? await urlToBlob(tags.artUrl) : null;
            const song = {
                id: 'song_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
                title: tags.title || cleanFilename(file.name),
                artist: tags.artist || 'Artista desconocido',
                album: tags.album || '',
                duration: 0,
                url,
                artUrl: tags.artUrl,
                artBlob,
                fileName: file.name,
                fileObj: file,
                lrcText: null,
                bpm: null,
                energy: null,
                lyricsStatus: null,  // null | 'found' | 'not_found' | 'searching'
            };
            state.library.push(song);
            // Persist to IndexedDB
            await idb.put(song.id, {
                file: song.fileObj, title: song.title, artist: song.artist,
                album: song.album, fileName: song.fileName, artBlob,
                lrcText: null, lyricsStatus: null, bpm: null, energy: null,
            });
        } catch (e) {
            console.error('Error loading', file.name, e);
            toast(`Error: ${file.name}`);
        }
    }

    // Match LRC files
    for (const lrcFile of lrcFiles) {
        const text = await lrcFile.text();
        const baseName = lrcFile.name.replace(/\.lrc$/i, '');
        const song = state.library.find(s => s.fileName.replace(/\.[^.]+$/,'') === baseName || s.title === baseName);
        if (song) { song.lrcText = text; song.lyricsStatus = 'found'; await updateSongInDB(song); }
    }

    if (state.library.length > 0) $('#uploadZone')?.classList.add('hidden');
    renderAll();
    toast(`${audioFiles.length} canción${audioFiles.length !== 1 ? 'es añadidas' : ' añadida'}`);

    // Auto-search lyrics
    setTimeout(() => autoSearchLyrics(), 800);
}

async function urlToBlob(url) {
    try { const r = await fetch(url); return await r.blob(); } catch(e) { return null; }
}

async function updateSongInDB(song) {
    await idb.put(song.id, {
        file: song.fileObj, title: song.title, artist: song.artist,
        album: song.album, fileName: song.fileName, artBlob: song.artBlob,
        lrcText: song.lrcText, lyricsStatus: song.lyricsStatus,
        bpm: song.bpm, energy: song.energy,
    });
}

async function extractMetadata(file) {
    const headerSize = Math.min(file.size, 512 * 1024);
    const buffer = await file.slice(0, headerSize).arrayBuffer();
    return parseID3Tags(buffer);
}

function cleanFilename(name) {
    return name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}

/* ===== Load from IndexedDB on startup ===== */
async function loadLibraryFromDB() {
    state.loadingFromDB = true;
    try {
        const all = await idb.getAll();
        for (const item of all) {
            const v = item.value;
            const url = URL.createObjectURL(v.file);
            const artUrl = v.artBlob ? URL.createObjectURL(v.artBlob) : null;
            state.library.push({
                id: item.key,
                title: v.title || cleanFilename(v.fileName || 'Canción'),
                artist: v.artist || 'Artista desconocido',
                album: v.album || '',
                duration: 0,
                url,
                artUrl,
                artBlob: v.artBlob,
                fileName: v.fileName,
                fileObj: v.file,
                lrcText: v.lrcText || null,
                bpm: v.bpm || null,
                energy: v.energy || null,
                lyricsStatus: v.lyricsStatus || null,
            });
        }
        if (state.library.length > 0) $('#uploadZone')?.classList.add('hidden');
    } catch(e) { console.error('DB load error', e); }
    state.loadingFromDB = false;
}

/* ===== LRCLIB Lyrics Search ===== */
async function searchLyricsOnline(artist, title, album, duration) {
    try {
        let url = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}`;
        if (album) url += `&album_name=${encodeURIComponent(album)}`;
        if (duration) url += `&duration=${Math.round(duration)}`;
        let res = await fetch(url);
        if (res.ok) {
            const data = await res.json();
            if (data.syncedLyrics) return data.syncedLyrics;
            if (data.plainLyrics) return data.plainLyrics;
        }
        const sUrl = `https://lrclib.net/api/search?q=${encodeURIComponent(artist + ' ' + title)}`;
        res = await fetch(sUrl);
        if (res.ok) {
            const results = await res.json();
            if (results && results.length > 0) {
                const best = results[0];
                if (best.syncedLyrics) return best.syncedLyrics;
                if (best.plainLyrics) return best.plainLyrics;
            }
        }
    } catch(e) { console.warn('Lyrics fetch error', e); }
    return null;
}

async function autoSearchLyrics() {
    const need = state.library.filter(s => !s.lrcText && s.lyricsStatus !== 'found' && s.lyricsStatus !== 'not_found');
    if (need.length === 0) { toast('Todas las canciones ya tienen letra o ya se buscaron'); return; }

    toast(`🔍 Buscando letras para ${need.length} canción${need.length !== 1 ? 'es' : ''}...`);

    let found = 0, notFound = 0;
    for (const song of need) {
        song.lyricsStatus = 'searching';
        renderLibrary();
        await new Promise(r => setTimeout(r, 400));

        const lyrics = await searchLyricsOnline(song.artist, song.title, song.album, song.duration);
        if (lyrics) { song.lrcText = lyrics; song.lyricsStatus = 'found'; found++; }
        else { song.lyricsStatus = 'not_found'; notFound++; }
        await updateSongInDB(song);
        if (state.currentSongId === song.id) renderLyrics();
        renderLibrary();
    }

    if (found > 0) toast(`✅ ${found} letra${found !== 1 ? 's' : ''} encontrada${found !== 1 ? 's' : ''}. ${notFound} no encontrada${notFound !== 1 ? 's' : ''}.`);
    else toast(`No se encontraron letras. Puedes añadirlas manualmente (☰ → Buscar/editar letra)`);
}

async function searchLyricsForSong(songId) {
    const song = state.library.find(s => s.id === songId);
    if (!song) return;
    const panel = $('#lyricsScroll');
    if (state.currentSongId === songId) {
        panel.innerHTML = `<div class="lyrics-loading"><div class="spinner"></div><p>Buscando letra en línea...</p></div>`;
    }
    song.lyricsStatus = 'searching';
    renderLibrary();
    const lyrics = await searchLyricsOnline(song.artist, song.title, song.album, song.duration);
    if (lyrics) { song.lrcText = lyrics; song.lyricsStatus = 'found'; await updateSongInDB(song); renderLyrics(); toast('✅ Letra encontrada'); }
    else { song.lyricsStatus = 'not_found'; await updateSongInDB(song); renderLyrics(); toast('No se encontró letra. Puedes añadirla manualmente.'); openLyricsEditorForSong(songId); }
}

/* ===== BPM & Energy ===== */
async function analyzeSong(song) {
    if (song.bpm !== null) return;
    try {
        const arrayBuffer = await song.fileObj.arrayBuffer();
        const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
        const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);
        tempCtx.close();
        song.bpm = detectBPM(audioBuffer);
        song.energy = detectEnergy(audioBuffer);
    } catch(e) { console.warn('Analysis failed', song.title, e); song.bpm = 0; song.energy = 0; }
}

function detectBPM(audioBuffer) {
    const channel = audioBuffer.getChannelData(0);
    const sr = audioBuffer.sampleRate;
    const cs = Math.floor(sr * 0.05);
    const nc = Math.floor(channel.length / cs);
    if (nc < 10) return 0;
    const energies = [];
    for (let i = 0; i < nc; i++) { let sum = 0; for (let j = 0; j < cs; j++) { const s = channel[i*cs+j]; sum += s*s; } energies.push(Math.sqrt(sum/cs)); }
    const avg = energies.reduce((a,b)=>a+b,0)/energies.length;
    const peaks = [];
    for (let i = 1; i < energies.length-1; i++) if (energies[i] > avg*1.4 && energies[i] > energies[i-1] && energies[i] >= energies[i+1]) peaks.push(i);
    if (peaks.length < 4) return 0;
    const intervals = [];
    for (let i = 1; i < peaks.length; i++) intervals.push(peaks[i]-peaks[i-1]);
    const hist = {};
    intervals.forEach(iv => { const b = Math.round(iv/2)*2; hist[b]=(hist[b]||0)+1; });
    let mc = 0, bi = 0;
    for (const [iv,c] of Object.entries(hist)) if (c > mc) { mc=c; bi=parseInt(iv); }
    const bp = bi*0.05;
    if (bp <= 0) return 0;
    let bpm = 60/bp;
    while (bpm < 70) bpm *= 2;
    while (bpm > 180) bpm /= 2;
    return Math.round(bpm);
}

function detectEnergy(audioBuffer) {
    const ch = audioBuffer.getChannelData(0);
    const sc = Math.min(ch.length, audioBuffer.sampleRate*30);
    let sum = 0;
    for (let i = 0; i < sc; i++) sum += ch[i]*ch[i];
    return Math.sqrt(sum/sc);
}

/* ===== DJ Mode ===== */
async function analyzeAllSongs() {
    const un = state.library.filter(s => s.bpm === null && s.fileObj);
    if (un.length === 0) return;
    toast(`🎧 Analizando ${un.length} canción${un.length !== 1 ? 'es' : ''}...`);
    for (let i = 0; i < un.length; i++) { await analyzeSong(un[i]); await updateSongInDB(un[i]); renderLibrary(); if (i < un.length-1) await new Promise(r=>setTimeout(r,100)); }
    toast('✅ Análisis completo');
}

function createDJPlaylist() {
    const analyzed = state.library.filter(s => s.bpm !== null && s.bpm > 0);
    if (analyzed.length < 2) return [];
    const maxE = Math.max(...analyzed.map(s => s.energy || 0), 0.001);
    const scored = analyzed.map(s => ({ ...s, energyNorm: (s.energy||0)/maxE }));
    scored.sort((a,b) => (a.energyNorm||0) - (b.energyNorm||0));
    const n = scored.length;
    const pl = [];
    for (let i = 0; i < Math.ceil(n/2); i++) pl.push(scored[i]);
    for (let i = n-1; i >= Math.ceil(n/2); i--) pl.push(scored[i]);
    for (let i = 1; i < pl.length-1; i++) {
        const prev = pl[i-1], curr = pl[i];
        const diff = Math.abs(prev.bpm - curr.bpm);
        if (diff > 25) {
            for (let j = i+1; j < Math.min(i+4, pl.length); j++) {
                if (Math.abs(prev.bpm - pl[j].bpm) < diff) { [pl[i], pl[j]] = [pl[j], pl[i]]; break; }
            }
        }
    }
    return pl;
}

async function toggleDJMode() {
    if (state.djMode) { state.djMode = false; $('#djBtn').classList.remove('active'); toast('Modo DJ desactivado'); renderLibrary(); return; }
    if (state.library.length < 2) { toast('Necesitas al menos 2 canciones'); return; }
    state.djMode = true; $('#djBtn').classList.add('active');
    toast('🎧 Activando DJ...');
    await analyzeAllSongs();
    state.djPlaylist = createDJPlaylist();
    if (state.djPlaylist.length === 0) { toast('No se pudo crear la sesión'); state.djMode = false; $('#djBtn').classList.remove('active'); return; }
    showDJPanel();
    ensureGraph();
    if (audioCtx && audioCtx.state === 'suspended') await audioCtx.resume();
    state.currentList = state.djPlaylist.map(s => s.id);
    state.currentIndex = 0;
    playSongByIndex(0);
    toast(`🎉 ¡Sesión DJ iniciada! ${state.djPlaylist.length} canciones con crossfade`);
}

function showDJPanel() {
    const panel = $('#djPanel');
    if (state.djPlaylist.length === 0) { panel.style.display = 'none'; return; }
    panel.style.display = 'block';
    const bpms = state.djPlaylist.map(s => s.bpm).filter(b => b > 0);
    const avg = bpms.length > 0 ? Math.round(bpms.reduce((a,b)=>a+b,0)/bpms.length) : 0;
    const min = bpms.length > 0 ? Math.min(...bpms) : 0;
    const max = bpms.length > 0 ? Math.max(...bpms) : 0;
    $('#djStats').innerHTML = `
        <div class="dj-stat"><strong>${state.djPlaylist.length}</strong> canciones</div>
        <div class="dj-stat">Tempo promedio: <strong>${avg}</strong> BPM</div>
        <div class="dj-stat">Rango: <strong>${min}-${max}</strong> BPM</div>
        <div class="dj-stat">Crossfade: <strong>${state.crossfadeSec}s</strong></div>`;
    const list = $('#songList');
    list.innerHTML = state.djPlaylist.map((s, i) => songRowHTML(s, i, 'dj')).join('');
}

/* ===== Crossfade ===== */
function startCrossfadeMonitor() {
    if (!state.djMode) return;
    const remaining = (audio.duration || 0) - audio.currentTime;
    if (remaining > 0 && remaining <= state.crossfadeSec + 1 && !state.crossfading) doCrossfade();
}

function doCrossfade() {
    if (state.currentIndex >= state.currentList.length - 1) { state.djMode = false; $('#djBtn').classList.remove('active'); toast('Sesión DJ terminada 🎵'); return; }
    state.crossfading = true;
    const inactiveDeck = getInactiveDeck();
    const inactiveGain = getInactiveGain();
    const activeGain = getActiveGain();
    const nextIdx = state.currentIndex + 1;
    const nextSong = state.library.find(s => s.id === state.currentList[nextIdx]);
    if (!nextSong) { state.crossfading = false; return; }
    inactiveDeck.src = nextSong.url;
    const fadeDuration = state.crossfadeSec;
    inactiveDeck.play().then(() => {
        const now = audioCtx ? audioCtx.currentTime : 0;
        if (audioCtx && inactiveGain && activeGain) {
            inactiveGain.gain.cancelScheduledValues(now);
            activeGain.gain.cancelScheduledValues(now);
            inactiveGain.gain.setValueAtTime(0, now);
            activeGain.gain.setValueAtTime(state.volume, now);
            inactiveGain.gain.linearRampToValueAtTime(state.volume, now + fadeDuration);
            activeGain.gain.linearRampToValueAtTime(0, now + fadeDuration);
        } else {
            inactiveDeck.volume = 0; audio.volume = state.volume;
            const steps = 40;
            for (let i = 0; i <= steps; i++) {
                setTimeout(() => { const p = i/steps; inactiveDeck.volume = p*state.volume; audio.volume = (1-p)*state.volume; }, (i/steps)*fadeDuration*1000);
            }
        }
        $('#crossfadeIndicator').classList.add('active');
        const cfFill = $('#cfFill');
        const cfStart = Date.now();
        const cfTimer = setInterval(() => { const e = (Date.now()-cfStart)/1000; cfFill.style.width = Math.min(100,(e/fadeDuration)*100)+'%'; if (e/fadeDuration >= 1) clearInterval(cfTimer); }, 100);
        setTimeout(() => {
            audio.pause();
            activeDeckId = activeDeckId === 'A' ? 'B' : 'A';
            audio = inactiveDeck;
            state.currentSongId = nextSong.id;
            state.currentIndex = nextIdx;
            state.crossfading = false;
            if (audioCtx && gainA && gainB) { (activeDeckId==='A'?gainA:gainB).gain.value = state.volume; (activeDeckId==='A'?gainB:gainA).gain.value = 0; }
            $('#crossfadeIndicator').classList.remove('active');
            $('#cfFill').style.width = '0%';
            renderAll(); updatePlayerBar();
            startCrossfadeMonitor();
        }, fadeDuration * 1000);
    }).catch(e => { console.error('Crossfade error', e); state.crossfading = false; });
}

/* ===== Rendering ===== */
function renderAll() {
    renderLibrary(); renderFavorites(); renderPlaylists(); renderPlaylistDetail(); renderNowPlaying(); updateBadges();
}

function songRowHTML(song, index, contextList) {
    const isCurrent = state.currentSongId === song.id;
    const isFav = state.favorites.includes(song.id);
    const artHTML = song.artUrl
        ? `<img src="${song.artUrl}" alt="">`
        : `<svg viewBox="0 0 24 24" width="20" height="20" fill="none"><path d="M9 18V5l12-2v13" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="6" cy="18" r="2.5" stroke="currentColor" stroke-width="1.5"/><circle cx="18" cy="16" r="2.5" stroke="currentColor" stroke-width="1.5"/></svg>`;

    // Lyrics status badge
    let lrcBadge = '';
    if (song.lyricsStatus === 'found' || song.lrcText) lrcBadge = '<span class="lrc-badge found" title="Tiene letra">♪</span>';
    else if (song.lyricsStatus === 'searching') lrcBadge = '<span class="lrc-badge searching" title="Buscando letra..."></span>';
    else if (song.lyricsStatus === 'not_found') lrcBadge = '<span class="lrc-badge notfound" title="Letra no encontrada">♪</span>';

    return `
    <div class="song-row ${isCurrent ? 'playing' : ''}" data-song-id="${song.id}" data-context-list="${contextList}">
        <div class="song-index">
            <span class="num">${index + 1}</span>
            <span class="play-hover"><svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 4l14 8-14 8V4z"/></svg></span>
            <span class="equalizer"><span></span><span></span><span></span></span>
        </div>
        <div class="song-art">${artHTML}</div>
        <div class="song-info">
            <div class="song-title">${escapeHTML(song.title)}</div>
            <div class="song-artist">${escapeHTML(song.artist)}${song.album ? ' — ' + escapeHTML(song.album) : ''}</div>
        </div>
        <div class="song-meta">
            ${lrcBadge}
            ${song.bpm ? `<span class="bpm-badge">${song.bpm} BPM</span>` : ''}
        </div>
        <div class="song-duration">${formatTime(song.duration)}</div>
        <div class="song-actions">
            <button class="icon-btn song-fav ${isFav ? 'favorited' : ''}" data-action="favorite" data-song-id="${song.id}" title="Favorito">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M12 21s-7-4.5-9.5-9C1 9 2.5 5.5 6 5.5c2 0 3.5 1 4 2 .5-1 2-2 4-2 3.5 0 5 3.5 3.5 6.5C19 16.5 12 21 12 21z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>
            </button>
            <button class="icon-btn song-more" data-action="context" data-song-id="${song.id}" title="Más opciones">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>
            </button>
        </div>
    </div>`;
}

function renderLibrary() {
    if (state.currentView === 'library' && state.djMode && state.djPlaylist.length > 0) { showDJPanel(); return; }
    const list = $('#songList');
    const search = $('#searchInput').value.toLowerCase().trim();
    let songs = state.library;
    if (search) songs = songs.filter(s => s.title.toLowerCase().includes(search) || s.artist.toLowerCase().includes(search) || (s.album && s.album.toLowerCase().includes(search)));
    $('#libraryCount').textContent = state.library.length === 0 ? 'Sin canciones todavía' : `${state.library.length} canción${state.library.length !== 1 ? 'es' : ''}`;
    if (state.library.length > 0) $('#uploadZone').classList.add('hidden');
    if (songs.length === 0 && state.library.length > 0) list.innerHTML = '<p class="empty-hint" style="padding:32px;text-align:center;">Sin resultados</p>';
    else list.innerHTML = songs.map((s, i) => songRowHTML(s, i, 'library')).join('');
}

function renderFavorites() {
    const list = $('#favSongList');
    const fav = state.library.filter(s => state.favorites.includes(s.id));
    $('#favCount').textContent = fav.length === 0 ? 'Aún no tienes favoritos' : `${fav.length} canción${fav.length !== 1 ? 'es' : ''}`;
    if (fav.length === 0) list.innerHTML = '<div class="upload-zone" style="border-style:solid;"><svg viewBox="0 0 24 24" width="40" height="40" fill="none"><path d="M12 21s-7-4.5-9.5-9C1 9 2.5 5.5 6 5.5c2 0 3.5 1 4 2 .5-1 2-2 4-2 3.5 0 5 3.5 3.5 6.5C19 16.5 12 21 12 21z" stroke="currentColor" stroke-width="1.5"/></svg><h3>Tus favoritos aparecerán aquí</h3><p>Toca el corazón en cualquier canción</p></div>';
    else list.innerHTML = fav.map((s, i) => songRowHTML(s, i, 'favorites')).join('');
}

function renderPlaylists() {
    const list = $('#playlistList');
    if (state.playlists.length === 0) { list.innerHTML = '<p class="empty-hint">Sin playlists aún</p>'; return; }
    list.innerHTML = state.playlists.map(pl => `
        <button class="playlist-item ${state.currentPlaylistId === pl.id && state.currentView === 'playlist' ? 'active' : ''}" data-playlist-id="${pl.id}">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M9 18V5l12-2v13" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="6" cy="18" r="2.5" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="16" r="2.5" stroke="currentColor" stroke-width="2"/></svg>
            <span class="pl-name">${escapeHTML(pl.name)}</span><span class="pl-count">${pl.songs.length}</span></button>`).join('');
}

function renderPlaylistDetail() {
    if (state.currentView !== 'playlist' || !state.currentPlaylistId) return;
    const pl = state.playlists.find(p => p.id === state.currentPlaylistId);
    if (!pl) return;
    $('#playlistDetailTitle').textContent = pl.name;
    const songs = pl.songs.map(id => state.library.find(s => s.id === id)).filter(Boolean);
    $('#playlistDetailCount').textContent = songs.length === 0 ? 'Vacía' : `${songs.length} canción${songs.length !== 1 ? 'es' : ''}`;
    const list = $('#playlistSongList');
    if (songs.length === 0) list.innerHTML = '<div class="upload-zone" style="border-style:solid;"><h3>Esta playlist está vacía</h3><p>Añade canciones desde tu biblioteca</p></div>';
    else list.innerHTML = songs.map((s, i) => songRowHTML(s, i, 'playlist:' + pl.id)).join('');
}

function renderNowPlaying() {
    const song = getCurrentSong();
    if (!song) {
        $('#npTitle').textContent = 'No hay canción'; $('#npArtist').textContent = 'Selecciona una canción';
        $('#npMeta').innerHTML = '';
        $('#npArt').innerHTML = '<div class="np-art-placeholder"><svg viewBox="0 0 24 24" width="64" height="64" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5"/><path d="M9 15V9l4 1.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>';
        renderLyrics(); return;
    }
    $('#npTitle').textContent = song.title;
    $('#npArtist').textContent = song.artist;
    let metaHTML = '';
    if (song.bpm) metaHTML += `<span class="bpm-badge">${song.bpm} BPM</span>`;
    if (song.album) metaHTML += `<span class="bpm-badge">${escapeHTML(song.album)}</span>`;
    $('#npMeta').innerHTML = metaHTML;
    if (song.artUrl) $('#npArt').innerHTML = `<img src="${song.artUrl}" alt="">`;
    else $('#npArt').innerHTML = '<div class="np-art-placeholder"><svg viewBox="0 0 24 24" width="64" height="64" fill="none"><path d="M9 18V5l12-2v13" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="6" cy="18" r="3" stroke="currentColor" stroke-width="1.5"/><circle cx="18" cy="16" r="3" stroke="currentColor" stroke-width="1.5"/></svg></div>';
    $('#npFavorite').classList.toggle('active', state.favorites.includes(song.id));
    renderLyrics();
}

function renderLyrics() {
    const song = getCurrentSong();
    const panel = $('#lyricsScroll');
    if (!song) { panel.innerHTML = `<div class="lyrics-empty"><svg viewBox="0 0 24 24" width="40" height="40" fill="none"><path d="M4 5h16M4 10h10M4 15h16M4 20h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><p>No hay canción</p></div>`; state.lyrics = []; return; }
    if (!song.lrcText) {
        panel.innerHTML = `
            <div class="lyrics-empty">
                <svg viewBox="0 0 24 24" width="40" height="40" fill="none"><path d="M4 5h16M4 10h10M4 15h16M4 20h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                <p>${song.lyricsStatus === 'not_found' ? 'No se encontró letra automática' : 'No hay letra para esta canción'}</p>
                <button class="text-btn" id="searchLyricsBtn">🔍 Buscar letra en línea</button>
                <button class="text-btn" id="addLyricsBtn" style="margin-top:8px;">Añadir letra manualmente</button>
            </div>`;
        $('#searchLyricsBtn')?.addEventListener('click', () => searchLyricsForSong(song.id));
        $('#addLyricsBtn')?.addEventListener('click', openLyricsEditor);
        state.lyrics = []; return;
    }
    const parsed = parseLRC(song.lrcText);
    state.lyrics = parsed;
    if (parsed.length === 0) { panel.innerHTML = song.lrcText.split('\n').map(l => `<div class="lyric-line">${escapeHTML(l) || '&nbsp;'}</div>`).join(''); panel.style.transform = ''; return; }
    panel.innerHTML = parsed.map((l, i) => `<div class="lyric-line" data-time="${l.time}" data-index="${i}">${escapeHTML(l.text) || '&nbsp;'}</div>`).join('');
    panel.querySelectorAll('.lyric-line').forEach(el => el.addEventListener('click', () => { const t = parseFloat(el.dataset.time); if (!isNaN(t)) audio.currentTime = t; }));
    updateLyricsHighlight();
}

function parseLRC(text) {
    const lines = text.split('\n');
    const result = [];
    const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    for (const line of lines) {
        let m; const times = []; re.lastIndex = 0;
        while ((m = re.exec(line)) !== null) { const min = parseInt(m[1]), sec = parseInt(m[2]), ms = m[3] ? parseInt(m[3].padEnd(3,'0')) : 0; times.push(min*60+sec+ms/1000); }
        const tc = line.replace(re, '').trim();
        if (times.length > 0) for (const t of times) result.push({ time: t, text: tc });
    }
    result.sort((a,b) => a.time - b.time);
    return result;
}

function updateLyricsHighlight() {
    if (state.lyrics.length === 0 || state.currentView !== 'nowplaying') return;
    const ct = audio.currentTime;
    let ai = -1;
    for (let i = 0; i < state.lyrics.length; i++) { if (state.lyrics[i].time <= ct) ai = i; else break; }
    const panel = $('#lyricsScroll');
    const lines = panel.querySelectorAll('.lyric-line');
    lines.forEach((el, i) => el.classList.toggle('active', i === ai));
    if (ai >= 0 && lines[ai]) { const ph = $('#npLyricsPanel').clientHeight; const off = lines[ai].offsetTop + lines[ai].offsetHeight/2 - ph/2; panel.style.transform = `translateY(${-off}px)`; }
}

function updateBadges() {
    const badge = $('#favBadge');
    badge.textContent = state.favorites.length > 0 ? state.favorites.filter(id => state.library.find(s => s.id === id)).length : '';
}

/* ===== Playback ===== */
function getCurrentSong() { return state.library.find(s => s.id === state.currentSongId); }
function playSongByIndex(i) { if (i >= 0 && i < state.currentList.length) playSong(state.currentList[i]); }

function playSong(songId, contextList) {
    const song = state.library.find(s => s.id === songId);
    if (!song) return;
    if (contextList) {
        if (contextList === 'library') state.currentList = state.library.map(s => s.id);
        else if (contextList === 'favorites') state.currentList = state.library.filter(s => state.favorites.includes(s.id)).map(s => s.id);
        else if (contextList === 'dj') state.currentList = state.djPlaylist.map(s => s.id);
        else if (contextList.startsWith('playlist:')) { const plId = contextList.split(':')[1]; const pl = state.playlists.find(p => p.id === plId); state.currentList = pl ? pl.songs : []; }
    }
    state.currentSongId = songId;
    state.currentIndex = state.currentList.indexOf(songId);
    ensureGraph();
    if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    const inactive = getInactiveDeck();
    if (inactive !== audio) inactive.pause();
    if (graphReady && getInactiveGain()) getInactiveGain().gain.value = 0;
    audio.src = song.url;
    audio.play().then(() => { state.isPlaying = true; updatePlayUI(); if (state.djMode) startCrossfadeMonitor(); }).catch(e => { console.error('Playback error', e); toast('No se pudo reproducir'); });
    renderAll(); updatePlayerBar();
}

function togglePlay() {
    if (!state.currentSongId) { if (state.library.length > 0) playSong(state.library[0].id, 'library'); return; }
    if (state.isPlaying) audio.pause(); else audio.play();
}

function nextSong() {
    if (state.currentList.length === 0) return;
    if (state.shuffle) { let n; do { n = Math.floor(Math.random()*state.currentList.length); } while (state.currentList.length > 1 && n === state.currentIndex); playSong(state.currentList[n]); return; }
    let ni = state.currentIndex + 1;
    if (ni >= state.currentList.length) { if (state.repeat === 'all') ni = 0; else return; }
    playSong(state.currentList[ni]);
}

function prevSong() {
    if (state.currentList.length === 0) return;
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    let pi = state.currentIndex - 1;
    if (pi < 0) { if (state.repeat === 'all') pi = state.currentList.length - 1; else pi = 0; }
    playSong(state.currentList[pi]);
}

function updatePlayUI() {
    $('#playIcon').style.display = state.isPlaying ? 'none' : 'block';
    $('#pauseIcon').style.display = state.isPlaying ? 'block' : 'none';
    $('#npArt')?.classList.toggle('playing-art', state.isPlaying);
    document.body.classList.toggle('audio-playing', state.isPlaying);
}

function updatePlayerBar() {
    const song = getCurrentSong();
    if (!song) { $('#playerTitle').textContent = 'Sin reproducción'; $('#playerArtist').textContent = '—'; $('#playerArt').innerHTML = '<div class="mini-placeholder"><svg viewBox="0 0 24 24" width="20" height="20" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5"/></svg></div>'; return; }
    $('#playerTitle').textContent = song.title;
    $('#playerArtist').textContent = song.artist;
    if (song.artUrl) $('#playerArt').innerHTML = `<img src="${song.artUrl}" alt="">`;
    else $('#playerArt').innerHTML = '<div class="mini-placeholder"><svg viewBox="0 0 24 24" width="20" height="20" fill="none"><path d="M9 18V5l12-2v13" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="6" cy="18" r="2.5" stroke="currentColor" stroke-width="1.5"/><circle cx="18" cy="16" r="2.5" stroke="currentColor" stroke-width="1.5"/></svg></div>';
    $('#playerFavorite').classList.toggle('favorited', state.favorites.includes(song.id));
}

/* ===== Audio Events ===== */
function onTimeUpdate(e) {
    if (e && e.target !== audio) return;
    if (audio.duration) { setProgress(audio.currentTime/audio.duration); $('#currentTime').textContent = formatTime(audio.currentTime); updateLyricsHighlight(); }
    if (state.djMode && state.isPlaying && !state.crossfading) startCrossfadeMonitor();
}
function onLoadedMetadata(e) {
    if (e && e.target !== audio) return;
    const song = getCurrentSong();
    if (song) { song.duration = audio.duration; $('#duration').textContent = formatTime(audio.duration); if (!state.loadingFromDB) renderLibrary(); }
}
function onPlay(e) { if (e && e.target !== audio) return; state.isPlaying = true; updatePlayUI(); if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); }
function onPause(e) { if (e && e.target !== audio) return; state.isPlaying = false; updatePlayUI(); }
function onEnded(e) { if (e && e.target !== audio) return; if (state.djMode) return; if (state.repeat === 'one') { audio.currentTime = 0; audio.play(); } else nextSong(); }

/* ===== Favorites ===== */
function toggleFavorite(songId) {
    const idx = state.favorites.indexOf(songId);
    if (idx >= 0) state.favorites.splice(idx, 1); else state.favorites.push(songId);
    saveState(); renderAll(); updatePlayerBar();
}

/* ===== Playlists ===== */
function createPlaylist(name) { const pl = { id: 'pl_' + Date.now(), name: name || 'Nueva playlist', songs: [] }; state.playlists.push(pl); saveState(); renderPlaylists(); return pl; }
function addToPlaylist(playlistId, songId) {
    const pl = state.playlists.find(p => p.id === playlistId);
    if (!pl) return;
    if (!pl.songs.includes(songId)) { pl.songs.push(songId); saveState(); renderPlaylists(); if (state.currentView === 'playlist' && state.currentPlaylistId === playlistId) renderPlaylistDetail(); toast(`Añadida a "${pl.name}"`); }
    else toast('Ya está en esta playlist');
}
function deletePlaylist(id) { state.playlists = state.playlists.filter(p => p.id !== id); saveState(); if (state.currentPlaylistId === id) switchView('library'); renderPlaylists(); toast('Playlist eliminada'); }

function showPlaylistModal(songId) {
    state.pendingPlaylistSongId = songId;
    const list = $('#playlistPickList');
    if (state.playlists.length === 0) list.innerHTML = '<p class="empty-hint">Crea una playlist arriba ↑</p>';
    else {
        list.innerHTML = state.playlists.map(pl => `<button class="playlist-pick" data-pl-id="${pl.id}"><svg viewBox="0 0 24 24" width="18" height="18" fill="none"><path d="M9 18V5l12-2v13" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="6" cy="18" r="2.5" stroke="currentColor" stroke-width="2"/><circle cx="18" cy="16" r="2.5" stroke="currentColor" stroke-width="2"/></svg>${escapeHTML(pl.name)}<span style="margin-left:auto;color:var(--text-3);font-size:12px;">${pl.songs.length}</span></button>`).join('');
        list.querySelectorAll('.playlist-pick').forEach(btn => btn.addEventListener('click', () => { addToPlaylist(btn.dataset.plId, state.pendingPlaylistSongId); closePlaylistModal(); }));
    }
    $('#newPlaylistInput').value = ''; $('#playlistModal').classList.add('show');
}
function closePlaylistModal() { $('#playlistModal').classList.remove('show'); state.pendingPlaylistSongId = null; }

/* ===== Lyrics Editor ===== */
function openLyricsEditor() {
    const song = getCurrentSong();
    if (!song) { toast('Reproduce una canción primero'); return; }
    openLyricsEditorForSong(song.id);
}
function openLyricsEditorForSong(songId) {
    const song = state.library.find(s => s.id === songId);
    if (!song) return;
    state.lyricsForSongId = songId;
    $('#lyricsTextarea').value = song.lrcText || '';
    $('#lyricsModal').classList.add('show');
}
function closeLyricsEditor() { $('#lyricsModal').classList.remove('show'); }
async function saveLyrics() {
    const text = $('#lyricsTextarea').value.trim();
    const song = state.library.find(s => s.id === state.lyricsForSongId);
    if (song) { song.lrcText = text || null; song.lyricsStatus = text ? 'found' : 'not_found'; await updateSongInDB(song); saveState(); renderLyrics(); renderLibrary(); toast(text ? 'Letra guardada' : 'Letra eliminada'); }
    closeLyricsEditor();
}

/* ===== Share ===== */
function shareSong(songId) {
    try {
        const song = state.library.find(s => s.id === songId) || getCurrentSong();
        if (!song) { toast('No hay canción para compartir'); return; }
        const shareText = `🎵 Estoy escuchando "${song.title}" de ${song.artist} en VibraSonic`;
        // Show share card
        $('#shareText').textContent = shareText;
        $('#shareCard').classList.add('show');
        setTimeout(() => $('#shareCard').classList.remove('show'), 4000);
        // Try Web Share API
        if (navigator.share) { navigator.share({ title: 'VibraSonic', text: shareText }).catch(() => {}); return; }
        // Try Clipboard API
        if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(shareText).then(() => toast('📋 Copiado al portapapeles')).catch(() => fallbackCopy(shareText)); return; }
        // Fallback
        fallbackCopy(shareText);
    } catch(e) { console.error('Share error', e); toast('No se pudo compartir'); }
}
function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;left:-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('📋 Copiado: puedes pegarlo donde quieras'); } catch(e) { toast(text); }
    document.body.removeChild(ta);
}

/* ===== Theme ===== */
function toggleTheme() { state.theme = state.theme === 'light' ? 'dark' : 'light'; applyTheme(); saveState(); }
function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = state.theme === 'dark' ? '#0a0a0c' : '#fa233b';
}

/* ===== Views ===== */
function switchView(view, playlistId) {
    state.currentView = view;
    $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));
    $$('.view').forEach(v => v.classList.remove('active'));
    if (view === 'library') $('#view-library').classList.add('active');
    else if (view === 'favorites') { $('#view-favorites').classList.add('active'); renderFavorites(); }
    else if (view === 'nowplaying') { $('#view-nowplaying').classList.add('active'); renderNowPlaying(); }
    else if (view === 'playlist') { state.currentPlaylistId = playlistId; $('#view-playlist').classList.add('active'); renderPlaylistDetail(); renderPlaylists(); }
    if (view === 'nowplaying') setTimeout(updateLyricsHighlight, 100);
    if (window.innerWidth <= 640) $('#sidebar').classList.add('collapsed');
}

/* ===== Context Menu ===== */
function showContextMenu(x, y, songId) {
    state.contextSongId = songId;
    const menu = $('#contextMenu');
    menu.style.left = Math.min(x, window.innerWidth - 220) + 'px';
    menu.style.top = Math.min(y, window.innerHeight - 320) + 'px';
    menu.classList.add('show');
    const isFav = state.favorites.includes(songId);
    const favBtn = menu.querySelector('[data-action="favorite"]');
    favBtn.innerHTML = favBtn.querySelector('svg').outerHTML + (isFav ? ' Quitar de favoritos' : ' Añadir a favoritos');
}
function hideContextMenu() { $('#contextMenu').classList.remove('show'); }

function renameSong(songId) {
    const song = state.library.find(s => s.id === songId);
    if (!song) return;
    const newTitle = prompt('Nuevo título:', song.title);
    if (newTitle && newTitle.trim()) {
        song.title = newTitle.trim();
        const newArtist = prompt('Nuevo artista:', song.artist);
        if (newArtist && newArtist.trim()) song.artist = newArtist.trim();
        updateSongInDB(song); saveState(); renderAll(); updatePlayerBar();
        toast('Canción renombrada');
    }
}

async function removeSong(songId) {
    if (!confirm('¿Eliminar esta canción?')) return;
    state.library = state.library.filter(s => s.id !== songId);
    state.favorites = state.favorites.filter(id => id !== songId);
    state.playlists.forEach(pl => { pl.songs = pl.songs.filter(id => id !== songId); });
    state.djPlaylist = state.djPlaylist.filter(s => s.id !== songId);
    if (state.currentSongId === songId) { audio.pause(); audio.src = ''; state.currentSongId = null; state.isPlaying = false; updatePlayUI(); }
    await idb.delete(songId);
    saveState(); renderAll(); updatePlayerBar();
    toast('Canción eliminada');
}

/* ===== Visualizer ===== */
let canvas, vctx, vizRAF;
function resizeCanvas() { if (canvas) { canvas.width = window.innerWidth; canvas.height = window.innerHeight; } }
function drawVisualizer() {
    if (!$('#visualizerOverlay').classList.contains('show')) { vizRAF = requestAnimationFrame(drawVisualizer); return; }
    if (analyser && dataArray) analyser.getByteFrequencyData(dataArray);
    else if (dataArray) { for (let i = 0; i < dataArray.length; i++) dataArray[i] = Math.max(0, dataArray[i] - 5); }
    if (!canvas) { canvas = $('#visualizerCanvas'); vctx = canvas.getContext('2d'); resizeCanvas(); }
    const w = canvas.width, h = canvas.height;
    vctx.clearRect(0, 0, w, h);
    if (state.vizMode === 'bars') drawBars(w, h);
    else if (state.vizMode === 'wave') drawWave(w, h);
    else if (state.vizMode === 'circle') drawCircle(w, h);
    vizRAF = requestAnimationFrame(drawVisualizer);
}
function drawBars(w, h) {
    const bc = 64, bw = w/bc*0.7, gap = w/bc*0.3, step = Math.floor(dataArray.length/bc);
    for (let i = 0; i < bc; i++) {
        let val = 0; for (let j = 0; j < step; j++) val += dataArray[i*step+j];
        val = (val/step)/255;
        const bh = val*h*0.7, x = i*(bw+gap)+gap/2, y = h-bh;
        const g = vctx.createLinearGradient(0, y, 0, h); g.addColorStop(0, '#ff416c'); g.addColorStop(1, '#fa233b');
        vctx.fillStyle = g; roundRect(vctx, x, y, bw, bh, Math.min(bw/2, 6)); vctx.fill();
    }
}
function drawWave(w, h) {
    if (analyser) analyser.getByteTimeDomainData(dataArray);
    for (let layer = 0; layer < 3; layer++) {
        vctx.globalAlpha = layer === 0 ? 1 : 0.3; vctx.lineWidth = layer === 0 ? 3 : 2;
        const g = vctx.createLinearGradient(0, 0, w, 0); g.addColorStop(0, '#fa233b'); g.addColorStop(0.5, '#ff416c'); g.addColorStop(1, '#a855f7');
        vctx.strokeStyle = g; vctx.beginPath();
        const slice = w/dataArray.length;
        for (let i = 0; i < dataArray.length; i++) { const v = (dataArray[i]-128)/128, amp = (layer+1)*0.4, y = h/2+v*h*0.3*amp; if (i === 0) vctx.moveTo(0, y); else vctx.lineTo(i*slice, y); }
        vctx.stroke();
    }
    vctx.globalAlpha = 1; if (analyser) analyser.getByteFrequencyData(dataArray);
}
function drawCircle(w, h) {
    const cx = w/2, cy = h/2, baseR = Math.min(w,h)*0.15, bars = 80;
    for (let i = 0; i < bars; i++) {
        const idx = Math.floor(i/bars*dataArray.length*0.6), val = dataArray[idx]/255;
        const bh = val*baseR*1.5, angle = (i/bars)*Math.PI*2 - Math.PI/2;
        const x1 = cx+Math.cos(angle)*baseR, y1 = cy+Math.sin(angle)*baseR;
        const x2 = cx+Math.cos(angle)*(baseR+bh), y2 = cy+Math.sin(angle)*(baseR+bh);
        vctx.strokeStyle = `hsl(${(i/bars)*60+340}, 80%, ${50+val*20}%)`; vctx.lineWidth = 3; vctx.lineCap = 'round';
        vctx.beginPath(); vctx.moveTo(x1, y1); vctx.lineTo(x2, y2); vctx.stroke();
    }
    const avg = dataArray.slice(0, 20).reduce((a,b)=>a+b,0)/20/255;
    const glowR = baseR*(0.8+avg*0.3);
    const rg = vctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
    rg.addColorStop(0, `rgba(250, 35, 59, ${0.3+avg*0.4})`); rg.addColorStop(1, 'rgba(250, 35, 59, 0)');
    vctx.fillStyle = rg; vctx.beginPath(); vctx.arc(cx, cy, glowR, 0, Math.PI*2); vctx.fill();
}
function roundRect(ctx, x, y, w, h, r) { if (h < 0) { y += h; h = -h; } r = Math.min(r, w/2, h/2); if (r < 0) r = 0; ctx.moveTo(x+r, y); ctx.arcTo(x+w, y, x+w, y+h, r); ctx.arcTo(x+w, y+h, x, y+h, r); ctx.arcTo(x, y+h, x, y, r); ctx.arcTo(x, y, x+w, y, r); ctx.closePath(); }
function toggleVisualizer() {
    ensureGraph();
    const overlay = $('#visualizerOverlay');
    if (overlay.classList.contains('show')) overlay.classList.remove('show');
    else { if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); if (!dataArray) dataArray = new Uint8Array(256); resizeCanvas(); overlay.classList.add('show'); }
}

/* ===== Utilities ===== */
function formatTime(sec) { if (!sec || isNaN(sec)) return '0:00'; const m = Math.floor(sec/60), s = Math.floor(sec%60); return `${m}:${s.toString().padStart(2,'0')}`; }
function escapeHTML(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }
function setProgress(p) { $('#progressFill').style.width = (p*100)+'%'; $('#progressHandle').style.left = (p*100)+'%'; }
function setVolumeUI(p) { $('#volumeFill').style.width = (p*100)+'%'; $('#volumeHandle').style.left = (p*100)+'%'; }
function setupDrag(barEl, fillEl, handleEl, onChange) {
    let dragging = false;
    function update(e) { const rect = barEl.getBoundingClientRect(); const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left; let p = Math.max(0, Math.min(1, x/rect.width)); fillEl.style.width = (p*100)+'%'; handleEl.style.left = (p*100)+'%'; onChange(p); }
    barEl.addEventListener('mousedown', e => { dragging = true; update(e); });
    document.addEventListener('mousemove', e => { if (dragging) update(e); });
    document.addEventListener('mouseup', () => { dragging = false; });
    barEl.addEventListener('touchstart', e => { dragging = true; update(e); }, { passive: true });
    document.addEventListener('touchmove', e => { if (dragging) update(e); }, { passive: true });
    document.addEventListener('touchend', () => { dragging = false; });
}

/* ===== Events ===== */
function initEvents() {
    $('#uploadBtn').addEventListener('click', () => $('#fileInput').click());
    $('#fileInput').addEventListener('change', e => { handleFiles(e.target.files); e.target.value = ''; });
    const zone = $('#uploadZone'), mainEl = $('#main');
    ['dragenter','dragover'].forEach(ev => mainEl.addEventListener(ev, e => { e.preventDefault(); if (zone && !zone.classList.contains('hidden')) zone.classList.add('dragover'); }));
    ['dragleave','drop'].forEach(ev => mainEl.addEventListener(ev, e => { e.preventDefault(); zone?.classList.remove('dragover'); }));
    mainEl.addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files); });

    $$('.nav-item').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));
    $('#searchInput').addEventListener('input', () => renderLibrary());
    $('#themeToggle').addEventListener('click', toggleTheme);

    $('#playBtn').addEventListener('click', togglePlay);
    $('#prevBtn').addEventListener('click', prevSong);
    $('#nextBtn').addEventListener('click', nextSong);
    $('#shuffleBtn').addEventListener('click', e => { state.shuffle = !state.shuffle; e.currentTarget.classList.toggle('active', state.shuffle); toast(state.shuffle ? 'Aleatorio activado' : 'Aleatorio desactivado'); });
    $('#repeatBtn').addEventListener('click', e => { const m = ['off','all','one']; state.repeat = m[(m.indexOf(state.repeat)+1)%3]; e.currentTarget.classList.toggle('active', state.repeat !== 'off'); toast(state.repeat === 'off' ? 'Repetir desactivado' : `Repetir ${state.repeat === 'all' ? 'todo' : 'canción'}`); });

    $('#playerFavorite').addEventListener('click', () => { if (state.currentSongId) toggleFavorite(state.currentSongId); });
    $('#npFavorite').addEventListener('click', () => { if (state.currentSongId) toggleFavorite(state.currentSongId); });
    $('#npLyricsSearch').addEventListener('click', () => { if (state.currentSongId) searchLyricsForSong(state.currentSongId); });
    $('#npLyricsToggle').addEventListener('click', openLyricsEditor);
    $('#npShare').addEventListener('click', () => { if (state.currentSongId) shareSong(state.currentSongId); });
    $('#lyricsBtnBottom').addEventListener('click', () => switchView('nowplaying'));
    $('#shareBtn').addEventListener('click', () => { if (state.currentSongId) shareSong(state.currentSongId); else toast('No hay canción reproduciéndose'); });
    $('#vizBtn').addEventListener('click', toggleVisualizer);

    $('#djBtn').addEventListener('click', toggleDJMode);
    $('#djPlayBtn').addEventListener('click', () => { if (state.djPlaylist.length > 0) { state.currentList = state.djPlaylist.map(s => s.id); state.currentIndex = 0; playSongByIndex(0); } });

    // Search all lyrics button
    $('#searchAllLyricsBtn')?.addEventListener('click', () => autoSearchLyrics());

    document.body.addEventListener('click', e => {
        const row = e.target.closest('.song-row');
        if (row && !e.target.closest('[data-action]')) { playSong(row.dataset.songId, row.dataset.contextList); return; }
        const favBtn = e.target.closest('[data-action="favorite"]');
        if (favBtn) { e.stopPropagation(); toggleFavorite(favBtn.dataset.songId); return; }
        const moreBtn = e.target.closest('[data-action="context"]');
        if (moreBtn) { e.stopPropagation(); const r = moreBtn.getBoundingClientRect(); showContextMenu(r.right-200, r.bottom+4, moreBtn.dataset.songId); return; }
        const plItem = e.target.closest('.playlist-item');
        if (plItem) { switchView('playlist', plItem.dataset.playlistId); return; }
    });

    $('#contextMenu').addEventListener('click', e => {
        const btn = e.target.closest('button'); if (!btn) return;
        const action = btn.dataset.action, songId = state.contextSongId;
        if (!action || !songId) return; hideContextMenu();
        switch (action) {
            case 'play': playSong(songId, 'library'); break;
            case 'favorite': toggleFavorite(songId); break;
            case 'addPlaylist': showPlaylistModal(songId); break;
            case 'lyrics': searchLyricsForSong(songId); break;
            case 'share': shareSong(songId); break;
            case 'rename': renameSong(songId); break;
            case 'remove': removeSong(songId); break;
        }
    });
    document.addEventListener('click', e => { if (!e.target.closest('#contextMenu') && !e.target.closest('[data-action="context"]')) hideContextMenu(); });

    $('#newPlaylistBtn').addEventListener('click', () => { const n = prompt('Nombre de la playlist:'); if (n && n.trim()) createPlaylist(n.trim()); });
    $('#playlistModalClose').addEventListener('click', closePlaylistModal);
    $('#createPlaylistModalBtn').addEventListener('click', () => { const n = $('#newPlaylistInput').value.trim(); if (!n) { toast('Escribe un nombre'); return; } const pl = createPlaylist(n); if (state.pendingPlaylistSongId) addToPlaylist(pl.id, state.pendingPlaylistSongId); closePlaylistModal(); });
    $('#newPlaylistInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#createPlaylistModalBtn').click(); });
    $('#playlistModal').addEventListener('click', e => { if (e.target === $('#playlistModal')) closePlaylistModal(); });

    $('#playlistPlayAll').addEventListener('click', () => { if (state.currentPlaylistId) { const pl = state.playlists.find(p => p.id === state.currentPlaylistId); if (pl && pl.songs.length > 0) playSong(pl.songs[0], 'playlist:'+pl.id); } });
    $('#playlistDelete').addEventListener('click', () => { if (state.currentPlaylistId) { const pl = state.playlists.find(p => p.id === state.currentPlaylistId); if (confirm(`¿Eliminar "${pl?.name}"?`)) deletePlaylist(state.currentPlaylistId); } });

    $('#lyricsModalClose').addEventListener('click', closeLyricsEditor);
    $('#lyricsSaveBtn').addEventListener('click', saveLyrics);
    $('#lyricsClearBtn').addEventListener('click', () => { $('#lyricsTextarea').value = ''; });
    $('#loadLrcBtn').addEventListener('click', () => $('#lrcFileInput').click());
    $('#lrcFileInput').addEventListener('change', async e => { const f = e.target.files[0]; if (f) $('#lyricsTextarea').value = await f.text(); e.target.value = ''; });
    $('#lyricsModal').addEventListener('click', e => { if (e.target === $('#lyricsModal')) closeLyricsEditor(); });

    $('#vizClose').addEventListener('click', toggleVisualizer);
    $$('.viz-mode').forEach(btn => btn.addEventListener('click', () => { state.vizMode = btn.dataset.mode; $$('.viz-mode').forEach(b => b.classList.remove('active')); btn.classList.add('active'); $('#vizModeLabel').textContent = btn.textContent; }));
    window.addEventListener('resize', resizeCanvas);

    setupDrag($('#progressBar'), $('#progressFill'), $('#progressHandle'), p => { if (audio.duration) audio.currentTime = p*audio.duration; });
    setupDrag($('#volumeBar'), $('#volumeFill'), $('#volumeHandle'), p => { setMasterVolume(p); setVolumeUI(p); });

    $('#sidebarToggle').addEventListener('click', () => $('#sidebar').classList.add('collapsed'));
    $('#menuOpen').addEventListener('click', () => $('#sidebar').classList.remove('collapsed'));

    document.addEventListener('keydown', e => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        switch (e.code) {
            case 'Space': e.preventDefault(); togglePlay(); break;
            case 'ArrowRight': if (e.shiftKey) nextSong(); else if (audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime+5); break;
            case 'ArrowLeft': if (e.shiftKey) prevSong(); else audio.currentTime = Math.max(0, audio.currentTime-5); break;
            case 'ArrowUp': e.preventDefault(); setMasterVolume(Math.min(1, state.volume+0.05)); setVolumeUI(state.volume); break;
            case 'ArrowDown': e.preventDefault(); setMasterVolume(Math.max(0, state.volume-0.05)); setVolumeUI(state.volume); break;
        }
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { $('#visualizerOverlay').classList.remove('show'); closeLyricsEditor(); closePlaylistModal(); hideContextMenu(); } });
}

/* ===== Init ===== */
async function init() {
    await idb.init();
    loadState();
    applyTheme();
    initEvents();
    const vol = parseFloat(localStorage.getItem('vs_volume') || '0.8');
    state.volume = isNaN(vol) ? 0.8 : vol;
    setVolumeUI(state.volume);
    if (!graphReady) audio.volume = state.volume;
    await loadLibraryFromDB();
    renderAll();
    updatePlayerBar();
    drawVisualizer();
    if (window.innerWidth <= 640) $('#sidebar').classList.add('collapsed');
    if (state.library.length > 0) {
        console.log(`%c🎵 VibraSonic listo — ${state.library.length} canciones cargadas`, 'color:#fa233b;font-size:14px;font-weight:bold;');
    } else {
        console.log('%c🎵 VibraSonic listo', 'color:#fa233b;font-size:14px;font-weight:bold;');
    }
}

document.addEventListener('DOMContentLoaded', init);
