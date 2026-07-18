'use strict';
// Auto-collections sweep: decade/vibe/Oscar/person/studio Jellyfin box sets
// derived from library metadata, reconciled every pass (posters rotated,
// retired names cleaned up). Owns: collSweepBusy (exposed via
// collectionsBusy()). Timers: startCollectionsTimer() → every 6h; the boot
// run is sequenced by server.js bootSequence().

const { cfg, HOST, oscarWinners, intlLanguages } = require('./config');
const { tfetch, tfetchJson } = require('./clients');
const { jellyfinUserId } = require('./jellyfin');
const { isMasterPaused } = require('./state');

// ---- Auto-collections sweep: decade / genre / top-rated collections, maintained natively ──
// "Automatic playlists by decade and genre" with NO third-party plugin: the controller derives
// rule-based Jellyfin COLLECTIONS (box sets — poster tiles in Movies → Collections) from
// library metadata and reconciles membership every pass, so they grow with the library and
// survive Jellyfin upgrades. Distinct names ("90s Movies", "Comedy Movies") can't collide
// with TMDb franchise box sets ("James Bond Collection"). Thin buckets (<5 titles) skipped.
let collSweepBusy = false;
async function collectionsSweep() {
  if (isMasterPaused() || collSweepBusy || !cfg.JELLYFIN_KEY) { console.log(`collectionsSweep: skipped (masterPaused=${isMasterPaused()} busy=${collSweepBusy} key=${!!cfg.JELLYFIN_KEY})`); return; }
  collSweepBusy = true;
  console.log('collectionsSweep: starting');
  try {
    const uid = await jellyfinUserId();
    const h = { 'X-Emby-Token': cfg.JELLYFIN_KEY };
    const q = new URLSearchParams({ IncludeItemTypes: 'Movie', Recursive: 'true', Fields: 'ProductionYear,Genres,CommunityRating,RunTimeTicks,ProviderIds,People,Studios,Tags', Limit: '5000' });
    const movies = ((await tfetchJson(`${HOST.jellyfin}/Users/${uid}/Items?${q}`, { headers: h }, 120000)).Items) || [];
    if (movies.length < 20) return;                       // tiny library — don't spam collections
    const buckets = new Map();                            // collection name -> { ids:Set, desc }
    const add = (name, desc, id) => { if (!buckets.has(name)) buckets.set(name, { ids: new Set(), desc }); buckets.get(name).ids.add(id); };
    const oscarBuckets = new Map();                        // collection name -> { items: Map<jfId, year>, desc }
    const OSCAR_DESC = {
      'Oscar: Best Picture (Winners)': 'The Academy Award for Best Picture — the year\'s finest film, as voted by the industry.',
      'Oscar: Best Picture (Nominees)': 'Every film nominated for Best Picture — the Academy\'s pick of the year\'s best.',
      'Oscar: Best Director (Winners)': 'Academy Award for Best Director — recognising outstanding directorial achievement.',
      'Oscar: Best Director (Nominees)': 'Every film whose director earned a nomination — the year\'s most acclaimed helmers.',
      'Oscar: Best Actor (Winners)': 'Academy Award for Best Actor — a leading performance that defined the year.',
      'Oscar: Best Actor (Nominees)': 'Every nominated lead performance — the year\'s most celebrated actors.',
      'Oscar: Best Actress (Winners)': 'Academy Award for Best Actress — a leading performance that defined the year.',
      'Oscar: Best Actress (Nominees)': 'Every nominated lead performance — the year\'s most celebrated actresses.',
      'Oscar: Best Supporting Actor (Winners)': 'Academy Award for Best Supporting Actor — scene-stealing in the best way.',
      'Oscar: Best Supporting Actor (Nominees)': 'Every nominated supporting performance — scene-stealers who nearly won.',
      'Oscar: Best Supporting Actress (Winners)': 'Academy Award for Best Supporting Actress — scene-stealing in the best way.',
      'Oscar: Best Supporting Actress (Nominees)': 'Every nominated supporting performance — scene-stealers who nearly won.',
      'Oscar: Best Film Editing (Winners)': 'Academy Award for Best Film Editing — the invisible art that shapes every great film.',
      'Oscar: Best Film Editing (Nominees)': 'Every nominated film for editing — the cuts that nearly took the prize.',
      'Oscar: Best Cinematography (Winners)': 'Academy Award for Best Cinematography — the year\'s most stunning visuals.',
      'Oscar: Best Cinematography (Nominees)': 'Every nominated film for cinematography — the year\'s most beautiful-looking films.',
    };
    const personBuckets = new Map();
    const pbAdd = (name, desc, id, year) => {
      if (!personBuckets.has(name)) personBuckets.set(name, { items: new Map(), desc });
      personBuckets.get(name).items.set(id, year || 0);
    };
    const ACTOR_MAP = new Map([
      ['robert de niro','Robert De Niro'],['al pacino','Al Pacino'],['marlon brando','Marlon Brando'],['jack nicholson','Jack Nicholson'],['daniel day-lewis','Daniel Day-Lewis'],['denzel washington','Denzel Washington'],['tom hanks','Tom Hanks'],['samuel l. jackson','Samuel L. Jackson'],['leonardo dicaprio','Leonardo DiCaprio'],['clint eastwood','Clint Eastwood'],['paul newman','Paul Newman'],['robert duvall','Robert Duvall'],['dustin hoffman','Dustin Hoffman'],['meryl streep','Meryl Streep'],['katharine hepburn','Katharine Hepburn'],['audrey hepburn','Audrey Hepburn'],['cary grant','Cary Grant'],['james stewart','James Stewart'],['humphrey bogart','Humphrey Bogart'],['judi dench','Judi Dench'],['helen mirren','Helen Mirren'],['ingrid bergman','Ingrid Bergman'],['joaquin phoenix','Joaquin Phoenix'],['brad pitt','Brad Pitt'],['julia roberts','Julia Roberts'],['spencer tracy','Spencer Tracy'],['sean penn','Sean Penn'],['robert redford','Robert Redford'],['jack lemmon','Jack Lemmon'],['peter o\'toole','Peter O\'Toole'],['john wayne','John Wayne'],['sean connery','Sean Connery'],['christopher walken','Christopher Walken'],['joe pesci','Joe Pesci'],['ralph fiennes','Ralph Fiennes'],['matthew mcconaughey','Matthew McConaughey'],['christian bale','Christian Bale'],['tom cruise','Tom Cruise'],['matt damon','Matt Damon'],['harrison ford','Harrison Ford'],['adam sandler','Adam Sandler'],['ben stiller','Ben Stiller'],['simon pegg','Simon Pegg'],['vince vaughn','Vince Vaughn'],['jennifer aniston','Jennifer Aniston'],['sacha baron cohen','Sacha Baron Cohen'],['laurence fishburne','Laurence Fishburne'],['jason sudeikis','Jason Sudeikis'],['jason bateman','Jason Bateman'],['bill hader','Bill Hader'],['mark wahlberg','Mark Wahlberg'],['ryan gosling','Ryan Gosling'],['ryan reynolds','Ryan Reynolds'],
    ]);
    const DIRECTOR_MAP = new Map([
      ['martin scorsese','Martin Scorsese'],['steven spielberg','Steven Spielberg'],['francis ford coppola','Francis Ford Coppola'],['billy wilder','Billy Wilder'],['quentin tarantino','Quentin Tarantino'],['stanley kubrick','Stanley Kubrick'],['alfred hitchcock','Alfred Hitchcock'],['akira kurosawa','Akira Kurosawa'],['david lean','David Lean'],['john ford','John Ford'],['orson welles','Orson Welles'],['christopher nolan','Christopher Nolan'],['ridley scott','Ridley Scott'],      ['sergio leone','Sergio Leone'],['charlie chaplin','Charlie Chaplin'],['frank capra','Frank Capra'],['ingmar bergman','Ingmar Bergman'],['bong joon ho','Bong Joon Ho'],
    ]);
    const COMPOSER_MAP = new Map([
      ['john williams','John Williams'],['hans zimmer','Hans Zimmer'],['ennio morricone','Ennio Morricone'],['howard shore','Howard Shore'],['bernard herrmann','Bernard Herrmann'],
    ]);
    const DIRECTOR_GROUPS = new Map([
      ['Coen Brothers', ['joel coen', 'ethan coen']],
    ]);
    const WRITER_MAP = new Map([
      ['aaron sorkin','Aaron Sorkin'],['david koepp','David Koepp'],['eric roth','Eric Roth'],['john logan','John Logan'],['william goldman','William Goldman'],
    ]);
    const STUDIO_ALIASES = new Map([['a24','A24'],['studio ghibli','Ghibli'],['ghibli','Ghibli'],['pixar','Pixar']]);
    const CINEMATOGRAPHERS = ['Roger Deakins','Vittorio Storaro','Emmanuel Lubezki','Robert Richardson','Gregg Toland'];
    const EDITORS = ['Thelma Schoonmaker','Michael Kahn','Walter Murch','Dede Allen','Sally Menke'];
    // VIBE COMBOS — short titles, flowery blurbs (→ the collection's Overview), and per-vibe
    // GENRE EXCLUSIONS so tones don't bleed (no cartoons in date night, no romance in the
    // action shelf). Thin results (<5 titles) auto-hide, so the list can be aspirational —
    // add a vibe as one entry: [name, blurb, test(m, year, minutes, rating)].
    const has = (m, g) => (m.Genres || []).includes(g);
    const none = (m, gs) => !gs.some((g) => has(m, g));
    // Tag helpers (TMDb keyword tags; case-insensitive) — power the occasion/mood vibes
    // that genre alone can't express (christmas, coming of age, based on book, sports, …).
    // Requires 'Tags' in the movie query Fields above.
    const tag = (m, t) => (m.Tags || []).some((x) => x.toLowerCase() === t);
    const tagAny = (m, ts) => (m.Tags || []).some((x) => ts.includes(x.toLowerCase()));
    const VIBES = [
      ['Mob Classics', 'Wiseguys, heists, and family business — crime cinema’s golden run through the ’80s and ’90s.',
        (m, y) => has(m, 'Crime') && y >= 1980 && y < 2000 && none(m, ['Animation', 'Documentary', 'Family', 'Romance'])],
      ['90s Action', 'Big explosions, bigger one-liners — pure ’90s adrenaline.',
        (m, y) => has(m, 'Action') && y >= 1990 && y < 2000 && none(m, ['Animation', 'Documentary', 'Romance', 'Family'])],
      ['80s Adventure', 'Whip-cracking, treasure-hunting, world-saving ’80s spirit.',
        (m, y, mins, r) => (has(m, 'Adventure') || has(m, 'Action')) && y >= 1980 && y < 1990 && r >= 6.5 && none(m, ['Animation', 'Documentary', 'Horror', 'Romance'])],
      ['Quick Action', 'All killer, no filler — action that wraps inside two hours.',
        (m, y, mins) => has(m, 'Action') && mins > 0 && mins <= 110 && none(m, ['Animation', 'Documentary', 'Romance', 'Family'])],
      ['Date Night: Classic', 'Old-school charm — romance and wit from Hollywood’s earlier eras.',
        (m, y, mins, r) => (has(m, 'Romance') || has(m, 'Comedy')) && y > 0 && y < 1980 && r >= 7 && none(m, ['Horror', 'Animation', 'Documentary', 'War'])],
      ['Date Night: Fun', 'Low-stakes laughs to share — nothing heavy, everything fun.',
        (m, y, mins, r) => has(m, 'Comedy') && (has(m, 'Romance') || has(m, 'Adventure') || has(m, 'Action')) && y >= 1995 && r >= 6.8 && mins > 0 && mins <= 130 && none(m, ['Horror', 'Animation', 'Documentary'])],
      ['Date Night: Romance', 'Love stories that earn the couch cuddle.',
        (m, y, mins, r) => has(m, 'Romance') && r >= 7 && mins > 0 && mins <= 145 && none(m, ['Horror', 'Animation', 'Documentary', 'Action', 'War'])],
      ['New Rom-Coms', 'Modern meet-cutes — 2010 and later.',
        (m, y) => has(m, 'Romance') && has(m, 'Comedy') && y >= 2010 && none(m, ['Horror', 'Animation', 'Documentary'])],
      ['2000s Rom-Coms', 'Frosted tips, flip phones, and falling in love — the 2000s way.',
        (m, y) => has(m, 'Romance') && has(m, 'Comedy') && y >= 2000 && y < 2010 && none(m, ['Horror', 'Animation', 'Documentary'])],
      ['Rom-Coms', 'Meet-cutes across the decades.',
        (m) => has(m, 'Romance') && has(m, 'Comedy') && none(m, ['Horror', 'Animation', 'Documentary'])],
      ['90s Comedies', 'Slackers, road trips, and endlessly quotable one-liners.',
        (m, y) => has(m, 'Comedy') && y >= 1990 && y < 2000 && none(m, ['Horror', 'Animation', 'Documentary'])],
      ['Feel-Good', 'Guaranteed mood-lifters — funny, warm, and easy to watch.',
        (m, y, mins, r) => has(m, 'Comedy') && r >= 7 && mins > 0 && mins <= 110 && none(m, ['Horror', 'Documentary', 'War'])],
      ['Nail-Biters', 'Tense, twisty, edge-of-the-seat.',
        (m, y, mins, r) => has(m, 'Thriller') && (has(m, 'Crime') || has(m, 'Mystery')) && r >= 6.8 && none(m, ['Animation', 'Documentary', 'Romance', 'Family'])],
      ['Mindbenders', 'Science fiction that rewires your brain on the way out.',
        (m, y, mins, r) => has(m, 'Science Fiction') && (has(m, 'Thriller') || has(m, 'Mystery') || has(m, 'Drama')) && r >= 7 && none(m, ['Animation', 'Documentary', 'Family'])],
      ['Space & Beyond', 'Strap in — voyages past the atmosphere.',
        (m) => has(m, 'Science Fiction') && has(m, 'Adventure') && none(m, ['Documentary'])],
      ['Family Night', 'Safe for the whole crew — animated favourites and family classics.',
        (m, y, mins, r) => (has(m, 'Family') || has(m, 'Animation')) && r >= 6.5 && none(m, ['Horror', 'Thriller'])],
      ['Horror Nights', 'Lights off. Volume up. Good luck.',
        (m, y, mins, r) => has(m, 'Horror') && r >= 6 && none(m, ['Documentary', 'Family'])],
      ['War Stories', 'From the trenches to the home front.',
        (m) => has(m, 'War') && none(m, ['Animation', 'Documentary'])],
      ['70s New Hollywood', 'The auteurs’ decade — gritty, personal, revolutionary.',
        (m, y, mins, r) => y >= 1970 && y < 1980 && r >= 7.2 && none(m, ['Animation', 'Documentary', 'Family'])],
      ['Old Hollywood', 'Black-and-white brilliance and technicolor dreams — pre-1970.',
        (m, y, mins, r) => y > 0 && y < 1970 && r >= 7 && none(m, ['Documentary'])],
      ['Masterpieces', 'Modern all-timers — the best-reviewed films since 2010.',
        (m, y, mins, r) => y >= 2010 && r >= 8.0 && none(m, ['Documentary'])],
      ['Animation Greats', 'Animated films that stand with the best of anything.',
        (m, y, mins, r) => has(m, 'Animation') && r >= 7.3],
      ['Fantasy Adventures', 'Dragons, quests, and enchanted lands — where imagination runs wild.',
        (m) => has(m, 'Fantasy') && has(m, 'Adventure') && none(m, ['Animation', 'Documentary', 'Family'])],
      ['True Stories', 'Based on real events — history brought to life through film.',
        (m, y, mins, r) => has(m, 'History') && has(m, 'Drama') && none(m, ['Fantasy', 'Animation', 'Documentary', 'Science Fiction'])],
      ['Western Roundup', 'Six-shooters, saloons, and vast landscapes — the American frontier on film.',
        (m, y, mins, r) => has(m, 'Western') && none(m, ['Documentary', 'Animation'])],
      ['Music & Musicals', 'Where music takes center stage — biopics, showstoppers, and rhythm-driven stories.',
        (m) => has(m, 'Music') && none(m, ['Documentary'])],
      ['Heists & Capers', 'The perfect plan, the big score, and the getaway — crime that thrills.',
        (m) => has(m, 'Crime') && has(m, 'Thriller') && none(m, ['Romance', 'Documentary', 'Animation', 'Fantasy'])],
      ['Mafia Epics', 'The families, the power, and the price — organized crime on the grandest scale.',
        (m, y, mins) => has(m, 'Crime') && has(m, 'Drama') && mins >= 140 && none(m, ['Comedy', 'War', 'Documentary'])],
      ['Cool Crime', 'Snappy dialogue, unforgettable characters, and style to burn — crime with a wink.',
        (m, y, mins) => has(m, 'Crime') && has(m, 'Comedy') && has(m, 'Drama') && mins <= 140 && none(m, ['Animation', 'Documentary', 'Horror'])],
      ['Caper Comedy', 'Witty cons, elaborate schemes, and the perfect payoff — crime that makes you laugh.',
        (m) => has(m, 'Comedy') && has(m, 'Crime') && none(m, ['Horror', 'Documentary', 'Animation', 'War'])],
      ['Noir Nights', 'Shadows, femmes fatales, and moral ambiguity — crime cinema at its darkest.',
        (m) => has(m, 'Crime') && has(m, 'Drama') && has(m, 'Mystery') && none(m, ['Animation', 'Documentary', 'Family'])],
      ['Buddy Action', 'Partners in crime-fighting — banter, explosions, and unlikely alliances.',
        (m) => has(m, 'Action') && has(m, 'Comedy') && none(m, ['Animation', 'Documentary', 'Family'])],
      ['Action Thrillers', 'Heart-pounding stakes and high-octane set-pieces — action that keeps you gripping the armrest.',
        (m) => has(m, 'Action') && has(m, 'Thriller') && none(m, ['Fantasy', 'Animation', 'Documentary'])],
      ['Spycraft', 'Secret agents, double-crosses, and global intrigue — the art of espionage.',
        (m) => has(m, 'Thriller') && has(m, 'Adventure') && none(m, ['Science Fiction', 'Fantasy', 'Animation', 'Documentary', 'Horror'])],
      ['Dystopian', 'Dark visions of what comes next — sci-fi that stares into the abyss.',
        (m) => has(m, 'Science Fiction') && (has(m, 'Thriller') || has(m, 'Drama')) && none(m, ['Animation', 'Documentary', 'Family'])],
      ['Slashers & Stalkers', 'Masked killers, body counts, and survival horror at its most visceral.',
        (m) => has(m, 'Horror') && has(m, 'Thriller') && none(m, ['Science Fiction', 'Fantasy', 'Documentary', 'Family', 'Animation', 'Adventure'])],
      ['Rip-Roaring Adventures', 'Thrills, chills, and non-stop entertainment — pure fun from start to finish.',
        (m) => has(m, 'Adventure') && has(m, 'Action') && none(m, ['Drama', 'Horror', 'Documentary', 'Animation', 'War'])],
      ['Fun Sci-Fi', 'Warp drives, time machines, and wisecracking robots — sci-fi that\'s pure fun.',
        (m, y, mins) => has(m, 'Science Fiction') && has(m, 'Adventure') && mins > 0 && mins <= 145 && none(m, ['Horror', 'Documentary', 'Family'])],
      ['Sweeping Romance', 'Grand love stories across turbulent times — epic romance at its most passionate.',
        (m, y, mins, r) => has(m, 'Romance') && has(m, 'Drama') && mins >= 120 && none(m, ['Comedy', 'Action', 'Horror', 'Animation'])],
      ['Top Docs', 'True stories, brilliantly told.',
        (m, y, mins, r) => has(m, 'Documentary') && r >= 7.5],
      // ── Collections v2 (2026-07-17) — mood/vibe/occasion shelves, see DESIGN-COLLECTIONS-V2.md ──
      ['Date Night: Action', 'Crowd-pleasing thrills to share — action and adventure that never turns grim.',
        (m, y, mins, r) => (has(m, 'Action') || has(m, 'Adventure')) && r >= 6.8 && mins > 0 && mins <= 140 && none(m, ['Horror', 'Documentary', 'War', 'Animation'])],
      ['Heavy Hitters', 'Serious, weighty drama — the films that stay with you long after the credits.',
        (m, y, mins, r) => has(m, 'Drama') && r >= 7.6 && mins >= 120 && none(m, ['Comedy', 'Animation', 'Family', 'Documentary', 'Adventure'])],
      ['Just Plain Fun', 'No baggage, all good time — the easiest yes on the shelf.',
        (m, y, mins, r) => (has(m, 'Comedy') || has(m, 'Adventure') || has(m, 'Family')) && r >= 6.8 && mins > 0 && mins <= 130 && none(m, ['Horror', 'Documentary', 'War', 'Drama'])],
      ['Epic Crime', 'Crime on the grandest scale — sprawling sagas of power, loyalty, and consequence.',
        (m, y, mins) => has(m, 'Crime') && mins >= 140 && none(m, ['Comedy', 'Documentary', 'Animation'])],
      ['Based on the Book', 'Read it first? Now watch it — films adapted straight from the page.',
        (m) => tag(m, 'based on novel or book')],
      ['Coming of Age', 'Growing up, figuring it out — the messy, formative years that shape us.',
        (m) => tag(m, 'coming of age')],
      ['Bring the Tissues', 'Have the tissues ready — beautiful, devastating, and worth every tear.',
        (m, y, mins, r) => tagAny(m, ['loss of loved one', 'dying and death']) && has(m, 'Drama') && r >= 7],
      ['Whodunits', 'A body, a puzzle, a reveal — mysteries that keep you guessing to the last frame.',
        (m) => has(m, 'Mystery') && tagAny(m, ['murder', 'detective', 'whodunit']) && none(m, ['Documentary'])],
      ['Dark Comedies', 'Laughs with a bite — comedy that isn’t afraid of the shadows.',
        (m) => tag(m, 'dark comedy') && none(m, ['Documentary'])],
      ['Revenge', 'Served cold — someone did someone wrong, and payback is coming.',
        (m, y, mins, r) => tag(m, 'revenge') && r >= 6.5 && none(m, ['Documentary', 'Family', 'Animation'])],
      ['Sports Night', 'The big game, the long shot, the comeback — glory on the field.',
        (m) => tag(m, 'sports') && none(m, ['Documentary'])],
      ['Road Trips', 'Hit the road — journeys that turn out to be about the company.',
        (m) => tagAny(m, ['road trip', 'road movie']) && none(m, ['Documentary'])],
      ['Monsters & Mayhem', 'Something big is coming — creatures, kaiju, and things that go bump.',
        (m) => tagAny(m, ['monster', 'creature', 'kaiju', 'giant monster']) || ((has(m, 'Horror') || has(m, 'Science Fiction')) && tag(m, 'alien') && has(m, 'Action'))],
      ['Time-Bending', 'Loops, paradoxes, and second chances — when the clock is a character.',
        (m) => tag(m, 'time travel')],
      // ── Collections v2, round 2 (2026-07-17) — promoted + additional vibes ──
      ['Neo-Noir', 'Shadows and moral rot, updated — noir for the modern age.',
        (m) => tag(m, 'neo-noir') && none(m, ['Documentary'])],
      ['Historical Epics', 'History on the grandest canvas — sweeping, ≥140-minute spectacle.',
        (m, y, mins, r) => has(m, 'History') && mins >= 140 && r >= 7 && none(m, ['Documentary'])],
      ['Satire & Send-Ups', 'Comedy that skewers — parody, satire, and sharp-elbowed farce.',
        (m) => tag(m, 'satire') && has(m, 'Comedy')],
      ['Courtroom & Conspiracy', 'Trials, cover-ups, and the fight for the truth.',
        (m, y, mins, r) => has(m, 'Drama') && tagAny(m, ['trial', 'courtroom', 'lawyer', 'politics', 'conspiracy', 'journalism']) && r >= 7 && none(m, ['Documentary', 'Animation'])],
      ['Space Opera', 'Galaxies far, far away — the grand tradition of Star Wars, Trek, and Dune.',
        (m) => tag(m, 'space opera')],
      ['Secret Agents', 'Tuxedos, gadgets, and global stakes — the art of espionage.',
        (m) => tagAny(m, ['spy', 'secret agent', 'british secret service']) && none(m, ['Documentary', 'Animation'])],
      ['Grown-Up Animation', 'Animation that isn’t for kids — mature, ambitious, unforgettable.',
        (m, y, mins, r) => has(m, 'Animation') && none(m, ['Family']) && r >= 6.5],
      ['Psychological Thrillers', 'Unreliable minds and creeping dread — thrillers that get under your skin.',
        (m, y, mins, r) => tagAny(m, ['psychological thriller', 'psychological drama', 'psychopath', 'paranoia', 'psychological']) && r >= 6.8 && none(m, ['Documentary', 'Family', 'Animation'])],
      ['Assassins & Hitmen', 'Cold professionals and one last job — killers with a code.',
        (m) => tagAny(m, ['hitman', 'assassin', 'assassination']) && none(m, ['Documentary', 'Family', 'Animation'])],
      ['Martial Arts', 'Fists, blades, and flawless choreography — combat as an art form.',
        (m) => tagAny(m, ['martial arts', 'kung fu', 'sword fight', 'samurai']) && none(m, ['Documentary'])],
      ['Con Artists', 'Grifters, marks, and the long con — trust no one.',
        (m) => tagAny(m, ['con artist', 'con man', 'grifter', 'scam', 'fraud', 'swindle']) && none(m, ['Documentary'])],
      ['Great Escapes', 'Locked in, breaking out — the desperate art of getting free.',
        (m, y, mins, r) => tagAny(m, ['prison', 'escape', 'prison escape']) && r >= 6.8 && none(m, ['Documentary', 'Animation', 'Fantasy'])],
      ['Robots & AI', 'Machines that think — androids, replicants, and the ghosts in the shell.',
        (m) => tagAny(m, ['artificial intelligence (a.i.)', 'robot', 'android', 'cyborg']) && none(m, ['Documentary'])],
      ['Political Thrillers', 'Power, secrets, and cover-ups — the game behind closed doors.',
        (m, y, mins, r) => tagAny(m, ['politics', 'political', 'president', 'conspiracy', 'cold war', 'espionage']) && has(m, 'Thriller') && r >= 6.8 && none(m, ['Documentary', 'Animation'])],
      ['Pirates & Treasure', 'Hoist the colours — high-seas adventure and buried gold.',
        (m) => tagAny(m, ['pirate', 'treasure hunt', 'treasure', 'high seas']) && none(m, ['Documentary'])],
      ['Teen Movies', 'Lockers, crushes, and growing pains — high school on film.',
        (m) => tagAny(m, ['high school', 'teenager', 'teen comedy', 'teen movie', 'teen fantasy']) && none(m, ['Documentary', 'Fantasy'])],
      ['Addiction & Excess', 'Highs, crashes, and the wreckage — appetite pushed past the edge.',
        (m, y, mins, r) => tagAny(m, ['drug addiction', 'drugs', 'addiction', 'alcoholism']) && has(m, 'Drama') && r >= 7 && none(m, ['Documentary'])],
      ['Anti-War', 'War without glory — the cost, the futility, the human toll.',
        (m, y, mins, r) => tag(m, 'anti war') && r >= 7 && none(m, ['Documentary'])],
    ];
    for (const m of movies) {
      const y = m.ProductionYear || 0;
      const mins = m.RunTimeTicks ? Math.round(m.RunTimeTicks / 600000000) : 0;
      const r = m.CommunityRating || 0;
      if (y >= 1950) {
        const d = Math.floor(y / 10) * 10;
        const label = d >= 2000 ? `${d}s` : `${String(d).slice(2)}s`;
        add(`${label} Movies`, `The library’s ${label} time capsule — everything we have from the decade.`, m.Id);
      }
      if (r >= 7.5) add('Critically Loved', 'The highest-rated films on the shelf. No duds allowed.', m.Id);
      if (mins > 0 && mins <= 100) add('Short & Sweet', 'Ninety-odd minutes, zero commitment.', m.Id);
      if (mins >= 150) add('Epics', 'Settle in — sagas that take their time and earn it.', m.Id);
      for (const [name, desc, test] of VIBES) if (test(m, y, mins, r)) add(name, desc, m.Id);
      const tmdb = m.ProviderIds?.Tmdb;
      if (tmdb && oscarWinners) {
        for (const [colName, items] of Object.entries(oscarWinners)) {
          if (items.some(i => String(i.tmdb_id) === String(tmdb))) {
            if (!oscarBuckets.has(colName)) oscarBuckets.set(colName, { items: new Map(), desc: OSCAR_DESC[colName] || colName });
            oscarBuckets.get(colName).items.set(m.Id, m.ProductionYear || 0);
          }
        }
      }
      if (tmdb && intlLanguages && intlLanguages[tmdb] && !has(m, 'Animation')) {
        add('International Films', 'Stories from around the world — cinema beyond English.', m.Id);
      }
      // Individual person/studio collections
      for (const p of m.People || []) {
        const pn = (p.Name || '').toLowerCase();
        const an = ACTOR_MAP.get(pn);
        if (p.Type === 'Actor' && an) pbAdd(an, `${an} — one of cinema’s most celebrated actors.`, m.Id, y);
        const dn = DIRECTOR_MAP.get(pn);
        if (p.Type === 'Director' && dn) pbAdd(dn, `Directed by ${dn} — visionary filmmaking.`, m.Id, y);
        if (p.Type === 'Director') {
          for (const [groupName, members] of DIRECTOR_GROUPS) {
            if (members.includes(pn)) pbAdd(groupName, `${groupName} — the sum is greater than the parts.`, m.Id, y);
          }
        }
        const cn = COMPOSER_MAP.get(pn);
        if (p.Type === 'Composer' && cn) pbAdd(cn, `Music by ${cn} — unforgettable scores.`, m.Id, y);
        const wn = WRITER_MAP.get(pn);
        if (p.Type === 'Writer' && wn) pbAdd(wn, `Written by ${wn} — masterful storytelling.`, m.Id, y);
      }
      for (const s of m.Studios || []) {
        const sn = (s.Name || '').toLowerCase();
        const cn = STUDIO_ALIASES.get(sn);
        if (cn) pbAdd(cn, cn === 'A24' ? 'A24 — bold, distinctive storytelling.' : cn === 'Ghibli' ? 'Studio Ghibli — the magic of Miyazaki and beyond.' : 'Pixar — animated masterpieces from the house that Woody built.', m.Id, y);
      }
    }
    for (const [name, b] of [...buckets]) if (b.ids.size < 5) buckets.delete(name);
    // Per-person Jellyfin queries for cinematographers and editors (not in People field)
    for (const person of CINEMATOGRAPHERS) {
      try {
        const pq = new URLSearchParams({ IncludeItemTypes: 'Movie', Person: person, Limit: '200', Fields: 'ProductionYear' });
        const items = ((await tfetchJson(`${HOST.jellyfin}/Users/${uid}/Items?${pq}`, { headers: h }, 30000)).Items) || [];
        if (items.length >= 5) personBuckets.set(person, { items: new Map(items.map((m) => [m.Id, m.ProductionYear || 0])), desc: `Shot by ${person} — stunning cinematography.` });
      } catch (e) { console.log(`personQuery: ${person} failed — ${e.message || e}`); }
    }
    for (const person of EDITORS) {
      try {
        const pq = new URLSearchParams({ IncludeItemTypes: 'Movie', Person: person, Limit: '200', Fields: 'ProductionYear' });
        const items = ((await tfetchJson(`${HOST.jellyfin}/Users/${uid}/Items?${pq}`, { headers: h }, 30000)).Items) || [];
        if (items.length >= 5) personBuckets.set(person, { items: new Map(items.map((m) => [m.Id, m.ProductionYear || 0])), desc: `Edited by ${person} — masterful storytelling through cuts.` });
      } catch (e) { console.log(`personQuery: ${person} failed — ${e.message || e}`); }
    }
    // Poster per collection: a RANDOM pick from its five best-rated members, re-rolled every
    // sweep — shelves get fresh faces twice a day instead of a frozen thumbnail.
    const byId = new Map(movies.map((m) => [m.Id, m]));
    const posterPick = (want) => {
      const top = [...want].map((x) => byId.get(x)).filter(Boolean)
        .sort((a, b) => (b.CommunityRating || 0) - (a.CommunityRating || 0)).slice(0, 5);
      return top[Math.floor(Math.random() * top.length)];
    };
    const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
    // DisplayOrder=Default makes Jellyfin honor STORED membership order (verified 2026-07-02)
    // — so re-writing membership shuffled = genuinely random browse order, refreshed each
    // sweep. Same dto update carries the flowery Overview.
    const ensureMeta = async (setId, desc, retries = 2) => {
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const dto = await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items/${setId}`, { headers: h }, 15000)).json();
          if (dto.DisplayOrder !== 'Default' || (desc && dto.Overview !== desc)) {
            dto.DisplayOrder = 'Default';
            if (desc) dto.Overview = desc;
            const r = await tfetch(`${HOST.jellyfin}/Items/${setId}`, { method: 'POST', headers: { ...h, 'Content-Type': 'application/json' }, body: JSON.stringify(dto) }, 30000);
            if (r.ok || r.status === 204) break;
          } else break;
        } catch (e) { if (attempt === retries) console.log(`ensureMeta: failed after ${retries + 1} attempts — ${e.message || e}`); }
      }
    };
    const setPoster = async (setId, memberId) => {
      const ir = await tfetch(`${HOST.jellyfin}/Items/${memberId}/Images/Primary?maxWidth=600&quality=90`, {}, 15000);
      if (!ir.ok) return false;
      const b64 = Buffer.from(await ir.arrayBuffer()).toString('base64');
      const ur = await tfetch(`${HOST.jellyfin}/Items/${setId}/Images/Primary`, { method: 'POST', headers: { ...h, 'Content-Type': ir.headers.get('content-type') || 'image/jpeg' }, body: b64 }, 20000);
      return ur.ok;
    };
    const bq = new URLSearchParams({ IncludeItemTypes: 'BoxSet', Recursive: 'true', Limit: '500' });
    const sets = ((await tfetchJson(`${HOST.jellyfin}/Users/${uid}/Items?${bq}`, { headers: h }, 45000)).Items) || [];
    const byName = new Map(sets.map((s) => [s.Name, s.Id]));
    // Retire the earlier plain-genre collections (redundant with the Genres tab). Explicit
    // name list so a TMDb franchise box set can never be caught by accident.
    const RETIRED = new Set([
      ...['Action', 'Adventure', 'Comedy', 'Crime', 'Drama', 'Romance', 'Science Fiction', 'Thriller', 'Horror', 'Animation', 'Family', 'Documentary', 'Fantasy', 'Mystery', 'War', 'Western', 'Music'].map((g) => `${g} Movies`),
      // superseded by the short-titled / era-dialed vibes
      'Date Night', 'Mob & Crime Classics (80s–90s)', '90s Action Blockbusters', 'Short Action Fix',
      'Old-School Date Night', 'Fun Date Night', 'Romantic Evening', 'Modern Rom-Coms (2010s+)',
      'Rom-Coms Through the Ages', 'Feel-Good Comedies', 'Edge-of-Seat Thrillers', 'Sci-Fi Mindbenders',
      'Family Movie Night', 'Old Hollywood (pre-70s)', 'Modern Masterpieces', '80s Adventure Classics',
      'Documentaries that Wow', 'Epic Runtimes',
      // Oscar collections renamed with (Winners)/(Nominees) suffixes
      'Oscar: Best Picture', 'Oscar: Best Director', 'Oscar: Best Actor', 'Oscar: Best Actress',
      'Oscar: Best Supporting Actor', 'Oscar: Best Supporting Actress',
      'Oscar: Best Film Editing', 'Oscar: Best Cinematography',
      // Grouped person collections → replaced by individual ones
      'Great Actors', 'Great Directors', 'Great Cinematographers', 'Great Editors',
      // Old aliased studio names → replaced by direct names
      'Studio: A24', 'Studio: Ghibli', 'Studio: Pixar',
      // Only 1 doc in the library, not worth its own shelf
      'Top Docs',
    ]);
    // Fix DisplayOrder for all existing collections first, regardless of load.
    for (const s of sets) {
      if (!RETIRED.has(s.Name)) await ensureMeta(s.Id).catch(() => {});
    }
    let removed = 0;
    for (const s of sets) {
      if (RETIRED.has(s.Name) && !buckets.has(s.Name)) {
        try { const r = await tfetch(`${HOST.jellyfin}/Items/${s.Id}`, { method: 'DELETE', headers: h }, 15000); if (r.ok || r.status === 204) removed++; } catch { /* */ }
      }
    }
    let created = 0, updated = 0, postered = 0;
    for (const [name, { ids: want, desc }] of buckets) {
      let setId = byName.get(name);
      if (!setId) {
        const r = await tfetch(`${HOST.jellyfin}/Collections?${new URLSearchParams({ Name: name, Ids: shuffle([...want]).join(',') })}`, { method: 'POST', headers: h }, 20000);
        if (!r.ok) continue;
        created++;
        try { setId = (await r.json()).Id; } catch { setId = null; }
        if (!setId) continue;
        await ensureMeta(setId, desc);
        const pick = posterPick(want);
        if (pick && await setPoster(setId, pick.Id).catch(() => false)) postered++;
        continue;
      }
      await ensureMeta(setId, desc);
      const cq = new URLSearchParams({ ParentId: setId, Limit: '5000' });
      const have = (((await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items?${cq}`, { headers: h }, 15000)).json()).Items) || []).map((i) => i.Id);
      // Only rewrite when membership actually changed: the DELETE+POST churn
      // leaves a partial-collection window and fires LibraryChanged storms
      // (clients page mid-rewrite → duplicate rows). Browse-order shuffle is
      // handled client-side by the TV/HSS rows, so a stale order is fine.
      if (have.length !== want.size || have.some((id) => !want.has(id))) {
        if (have.length) await tfetch(`${HOST.jellyfin}/Collections/${setId}/Items?Ids=${have.join(',')}`, { method: 'DELETE', headers: h }, 30000);
        await tfetch(`${HOST.jellyfin}/Collections/${setId}/Items?Ids=${shuffle([...want]).join(',')}`, { method: 'POST', headers: h }, 30000);
        updated++;
      }
      const pick = posterPick(want);
      if (pick && await setPoster(setId, pick.Id).catch(() => false)) postered++;
    }
    // Oscar winner collections: year-descending order (newest first), never shuffled.
    for (const [colName, { items, desc }] of oscarBuckets) {
      const sorted = [...items.entries()].sort((a, b) => b[1] - a[1]);
      const want = new Set(sorted.map(([id]) => id));
      let setId = byName.get(colName);
      if (!setId) {
        const ids = [...want];
        // create collection with first chunk; add remaining chunks to it
        const first = ids.slice(0, 100);
        const r = await tfetch(`${HOST.jellyfin}/Collections?${new URLSearchParams({ Name: colName, Ids: first.join(',') })}`, { method: 'POST', headers: h }, 45000);
        if (!r.ok) continue;
        created++;
        try { setId = (await r.json()).Id; } catch { setId = null; }
        if (!setId) continue;
        for (let i = 100; i < ids.length; i += 100) {
          await tfetch(`${HOST.jellyfin}/Collections/${setId}/Items?Ids=${ids.slice(i, i + 100).join(',')}`, { method: 'POST', headers: h }, 45000);
        }
        await ensureMeta(setId, desc);
        const pick = posterPick(want);
        if (pick && await setPoster(setId, pick.Id).catch(() => false)) postered++;
        continue;
      }
      await ensureMeta(setId, desc);
      const cq = new URLSearchParams({ ParentId: setId, Limit: '5000' });
      const have = (((await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items?${cq}`, { headers: h }, 30000)).json()).Items) || []).map((i) => i.Id);
      if (have.length) {
        for (let i = 0; i < have.length; i += 100) {
          await tfetch(`${HOST.jellyfin}/Collections/${setId}/Items?Ids=${have.slice(i, i + 100).join(',')}`, { method: 'DELETE', headers: h }, 45000);
        }
      }
      const ids = [...want];
      for (let i = 0; i < ids.length; i += 100) {
        await tfetch(`${HOST.jellyfin}/Collections/${setId}/Items?Ids=${ids.slice(i, i + 100).join(',')}`, { method: 'POST', headers: h }, 45000);
      }
      updated++;
      const pick = posterPick(want);
      if (pick && await setPoster(setId, pick.Id).catch(() => false)) postered++;
    }
    // Person/studio collections: shuffled order, min 5 items.
    for (const [colName, { items, desc }] of personBuckets) {
      const want = shuffle([...items.keys()]);
      if (want.length < 5) continue;
      let setId = byName.get(colName);
      if (!setId) {
        const first = want.slice(0, 100);
        const r = await tfetch(`${HOST.jellyfin}/Collections?${new URLSearchParams({ Name: colName, Ids: first.join(',') })}`, { method: 'POST', headers: h }, 45000);
        if (!r.ok) continue;
        created++;
        try { setId = (await r.json()).Id; } catch { setId = null; }
        if (!setId) continue;
        for (let i = 100; i < want.length; i += 100) {
          await tfetch(`${HOST.jellyfin}/Collections/${setId}/Items?Ids=${want.slice(i, i + 100).join(',')}`, { method: 'POST', headers: h }, 45000);
        }
        await ensureMeta(setId, desc);
        const pick = posterPick(new Set(want));
        if (pick && await setPoster(setId, pick.Id).catch(() => false)) postered++;
        continue;
      }
      await ensureMeta(setId, desc);
      const cq = new URLSearchParams({ ParentId: setId, Limit: '5000' });
      const have = (((await (await tfetch(`${HOST.jellyfin}/Users/${uid}/Items?${cq}`, { headers: h }, 30000)).json()).Items) || []).map((i) => i.Id);
      if (have.length) {
        for (let i = 0; i < have.length; i += 100) {
          await tfetch(`${HOST.jellyfin}/Collections/${setId}/Items?Ids=${have.slice(i, i + 100).join(',')}`, { method: 'DELETE', headers: h }, 45000);
        }
      }
      for (let i = 0; i < want.length; i += 100) {
        await tfetch(`${HOST.jellyfin}/Collections/${setId}/Items?Ids=${want.slice(i, i + 100).join(',')}`, { method: 'POST', headers: h }, 45000);
      }
      updated++;
      const pick = posterPick(new Set(want));
      if (pick && await setPoster(setId, pick.Id).catch(() => false)) postered++;
    }
    if (created || updated || postered || removed) console.log(`collectionsSweep: ${created} created, ${updated} reshuffled, ${postered} poster(s) rotated, ${removed} retired (${buckets.size} auto-collections, ${oscarBuckets.size} Oscar, ${personBuckets.size} person/studio collections)`);
  } catch (e) { console.log(`collectionsSweep: failed — ${e.message || e}`); }
  finally { collSweepBusy = false; }
}

function startCollectionsTimer() {
setInterval(collectionsSweep, 6 * 3600000);   // twice a day keeps them fresh
}
function collectionsBusy() { return collSweepBusy; }

module.exports = { collectionsSweep, collectionsBusy, startCollectionsTimer };
