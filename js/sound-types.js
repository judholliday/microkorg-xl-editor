// Reviewed corrections to soundtype.js's rules for the bundled presets, keyed "<bank file>/<name>".
export const OVERRIDES = {
  'MKXL_FactoryPreset/8BIT GAL': 'Lead',
  'MKXL_FactoryPreset/P6 CHORD': 'Synth',
  'MKXL_FactoryPreset/VELOSLAP': 'Bass',
  'MKXL_FactoryPreset/MS-101': 'Bass',
  'MKXL_FactoryPreset/ICEFIELD': 'Pad',
  'MKXL_FactoryPreset/PHATLINE': 'Bass',
  'MKXL_FactoryPreset/BELLY': 'Pad',
  'MKXL_FactoryPreset/ROBOSYNC': 'Synth',
  'MKXL_FactoryPreset/Z-FIELD': 'Arp & Sequence',
  'MKXL_FactoryPreset/MELOBELL': 'Bells & Mallets',
  'MKXL_FactoryPreset/DEEPBELL': 'Bells & Mallets',
  'MS2KB_FactoryPreset/NUSKOOLD': 'Synth',
  'MK_FactoryPreset/GATEDSYN': 'Synth',
  'MK_FactoryPreset/SWEEPMIN': 'Lead',
  'MK_FactoryPreset/SYNTH CL': 'Keys',
  'MK_FactoryPreset/LOUNGE O': 'Organ',
  'MK_FactoryPreset/GATED CH': 'Synth',
  'MS2KB_FactoryPreset/GATEDSYN': 'Synth',
  'MS2KB_FactoryPreset/ACIDSAWB': 'Bass',
  'MS2KB_FactoryPreset/LOUNGE O': 'Organ',
  'MS2K_FactoryPreset/HEALING': 'Pad',
  'MS2K_FactoryPreset/JET SET': 'FX & Noise',
  'MS2K_FactoryPreset/BELLY': 'Pad',
  'MS2K_FactoryPreset/SYNTH CL': 'Keys',
  'MS2K_FactoryPreset/LOUNGE O': 'Organ',
  'MS2K_FactoryPreset/WET REED': 'Keys',
  "MS2K_FactoryPreset/BAKIN' B": 'Bass',
  // Prophet-5 1978 factory programs converted by tools/prophet/convert.mjs
  'Prophet5_1978/BRASS': 'Brass',
  'Prophet5_1978/LOSTRNGS': 'Strings',
  'Prophet5_1978/MUTE CLV': 'Keys',
  'Prophet5_1978/PERC EP': 'Keys',
  'Prophet5_1978/FLUTES': 'Lead',
  'Prophet5_1978/HARPSCRD': 'Keys',
  'Prophet5_1978/SYNC I': 'Lead',
  'Prophet5_1978/PERC ORG': 'Organ',
  'Prophet5_1978/UNI GLID': 'Lead',
  'Prophet5_1978/HARMONUM': 'Organ',
  'Prophet5_1978/ORG RESO': 'Organ',
  'Prophet5_1978/TOY PNO': 'Keys',
  'Prophet5_1978/TRMP/FLT': 'Brass',
  'Prophet5_1978/FILT MOD': 'Synth',
  'Prophet5_1978/REED ORG': 'Organ',
  'Prophet5_1978/BRASS5TH': 'Brass',
  'Prophet5_1978/PIPE FLT': 'Organ',
  'Prophet5_1978/SYNC II': 'Lead',
  'Prophet5_1978/E.PIANO': 'Keys',
  'Prophet5_1978/HISTRNGS': 'Strings',
  'Prophet5_1978/OCT SAWS': 'Synth',
  'Prophet5_1978/REL REPT': 'Synth',
  'Prophet5_1978/DLY HARM': 'Synth',
  'Prophet5_1978/ECHO REP': 'Arp & Sequence',
  'Prophet5_1978/PWM': 'Pad',
  'Prophet5_1978/SLO SWP': 'Pad',
  'Prophet5_1978/4THS RES': 'Synth',
  'Prophet5_1978/SWP HARM': 'Pad',
  'Prophet5_1978/SLO SYNC': 'Synth',
  'Prophet5_1978/RAND ARP': 'Arp & Sequence',
  'Prophet5_1978/SAW ARP': 'Arp & Sequence',
  'Prophet5_1978/CLNGBELL': 'Bells & Mallets',
  'Prophet5_1978/ALIEN': 'FX & Noise',
  'Prophet5_1978/NOISESWP': 'FX & Noise',
  'Prophet5_1978/DESCBELL': 'Bells & Mallets',
  'Prophet5_1978/DESC PWM': 'Pad',
  'Prophet5_1978/HELICPTR': 'FX & Noise',
  'Prophet5_1978/RESOBELL': 'Bells & Mallets',

  // Roland Juno-60 and Juno-106 factory patches converted by tools/juno/convert.mjs, typed by their Roland names
  'Juno60_Factory/STRNG 1': 'Strings', // 11 Strings 1
  'Juno60_Factory/STRNG 2': 'Strings', // 12 Strings 2
  'Juno60_Factory/STRNG 3': 'Strings', // 13 Strings 3
  'Juno60_Factory/ORGAN 1': 'Organ', // 14 Organ 1
  'Juno60_Factory/ORGAN 2': 'Organ', // 15 Organ 2
  'Juno60_Factory/ORGAN 3': 'Organ', // 16 Organ 3
  'Juno60_Factory/BRASS': 'Brass', // 17 Brass
  'Juno60_Factory/PHASEBRA': 'Brass', // 18 Phase Brass
  'Juno60_Factory/PIANO 1': 'Keys', // 21 Piano 1
  'Juno60_Factory/PIANO 2': 'Keys', // 22 Piano 2
  'Juno60_Factory/CELESTA': 'Bells & Mallets', // 23 Celesta
  'Juno60_Factory/MELLOWPN': 'Keys', // 24 Mellow Piano
  'Juno60_Factory/HRPSCD 1': 'Keys', // 25 Harpsichord 1
  'Juno60_Factory/HRPSCD 2': 'Keys', // 26 Harpsichord 2
  'Juno60_Factory/GUITAR': 'Keys', // 27 Guitar
  'Juno60_Factory/SYN HARP': 'Keys', // 28 Synthesizer Harp
  'Juno60_Factory/BASS 1': 'Bass', // 31 Bass 1
  'Juno60_Factory/BASS 2': 'Bass', // 32 Bass 2
  'Juno60_Factory/CLAVI 1': 'Keys', // 33 Clavichord 1
  'Juno60_Factory/CLAVI 2': 'Keys', // 34 Clavichord 2
  'Juno60_Factory/PIZZSND1': 'Strings', // 35 Pizzicato Sound 1
  'Juno60_Factory/PIZZSND2': 'Strings', // 36 Pizzicato Sound 2
  'Juno60_Factory/XYLOFON': 'Bells & Mallets', // 37 Xylophone
  'Juno60_Factory/GLOCKEN': 'Bells & Mallets', // 38 Glockenspiel
  'Juno60_Factory/VIOLIN': 'Strings', // 41 Violin
  'Juno60_Factory/TRUMPET': 'Brass', // 42 Trumpet
  'Juno60_Factory/HORN': 'Brass', // 43 Horn
  'Juno60_Factory/TUBA': 'Brass', // 44 Tuba
  'Juno60_Factory/FLUTE': 'Lead', // 45 Flute
  'Juno60_Factory/CLARINET': 'Lead', // 46 Clarinet
  'Juno60_Factory/OBOE': 'Lead', // 47 Oboe
  'Juno60_Factory/ENG HORN': 'Lead', // 48 English Horn
  'Juno60_Factory/FUNNYCAT': 'FX & Noise', // 51 Funny Cat
  'Juno60_Factory/WAHBRASS': 'Brass', // 52 Wah Brass
  'Juno60_Factory/PHASECOM': 'Pad', // 53 Phase Combination
  'Juno60_Factory/REED 1': 'Lead', // 54 Reed 1
  'Juno60_Factory/POPCORN': 'Pluck & Stab', // 55 Popcorn
  'Juno60_Factory/REED 2': 'Lead', // 56 Reed 2
  'Juno60_Factory/REED 3': 'Lead', // 57 Reed 3
  'Juno60_Factory/PWMCHORU': 'Pad', // 58 PWM Chorus
  'Juno60_Factory/SYNORGAN': 'Organ', // 61 Synthesizer Organ
  'Juno60_Factory/FX SND 1': 'FX & Noise', // 62 Effect Sound 1
  'Juno60_Factory/FX SND 2': 'FX & Noise', // 63 Effect Sound 2
  'Juno60_Factory/SPACEHAR': 'Keys', // 64 Space Harp
  'Juno60_Factory/FUNK': 'Pluck & Stab', // 65 Funk
  'Juno60_Factory/SPACESND': 'FX & Noise', // 66 Space Sound 1
  'Juno60_Factory/MYSTERY': 'FX & Noise', // 67 Mysterious Invention
  'Juno60_Factory/SPACESN2': 'FX & Noise', // 68 Space Sound 2
  'Juno60_Factory/PERCSND1': 'Drums & Hits', // 71 Percussive Sound 1
  'Juno60_Factory/PERCSND2': 'Drums & Hits', // 72 Percussive Sound 2
  'Juno60_Factory/WHISTLE': 'Lead', // 73 Whistle
  'Juno60_Factory/FX SND 3': 'FX & Noise', // 74 Effect Sound 3
  'Juno60_Factory/UFO': 'FX & Noise', // 75 UFO
  'Juno60_Factory/SPACESN3': 'FX & Noise', // 76 Space Sound 3
  'Juno60_Factory/SURF': 'FX & Noise', // 77 Surf
  'Juno60_Factory/SYN DRUM': 'Drums & Hits', // 78 Synthesizer Drum
  'Juno106_Factory/BRASS': 'Brass', // A11 Brass
  'Juno106_Factory/BRASSSWE': 'Brass', // A12 Brass Swell
  'Juno106_Factory/TRUMPET': 'Brass', // A13 Trumpet
  'Juno106_Factory/FLUTES': 'Lead', // A14 Flutes
  'Juno106_Factory/MOVINGST': 'Strings', // A15 Moving Strings
  'Juno106_Factory/BRASS&ST': 'Brass', // A16 Brass & Strings
  'Juno106_Factory/CHOIR': 'Pad', // A17 Choir
  'Juno106_Factory/PIANO I': 'Keys', // A18 Piano I
  'Juno106_Factory/ORGAN I': 'Organ', // A21 Organ I
  'Juno106_Factory/ORGAN II': 'Organ', // A22 Organ II
  'Juno106_Factory/COMBOORG': 'Organ', // A23 Combo Organ
  'Juno106_Factory/CALLIOPE': 'Organ', // A24 Calliope
  'Juno106_Factory/DONALDPL': 'Pluck & Stab', // A25 Donald Pluck
  'Juno106_Factory/CELESTE': 'Bells & Mallets', // A26 Celeste
  'Juno106_Factory/ELECT.PI': 'Keys', // A27 Elect. Piano I
  'Juno106_Factory/ELECT.P2': 'Keys', // A28 Elect. Piano II
  'Juno106_Factory/CLOCKCHI': 'Bells & Mallets', // A31 Clock Chimes
  'Juno106_Factory/STEELDRU': 'Bells & Mallets', // A32 Steel Drums
  'Juno106_Factory/XYLOFON': 'Bells & Mallets', // A33 Xylophone
  'Juno106_Factory/BRASSIII': 'Brass', // A34 Brass III
  'Juno106_Factory/FANFARE': 'Brass', // A35 Fanfare
  'Juno106_Factory/STRNGIII': 'Strings', // A36 Strings III
  'Juno106_Factory/PIZZ': 'Strings', // A37 Pizzicato
  'Juno106_Factory/HIGHSTRN': 'Strings', // A38 High Strings
  'Juno106_Factory/BASSCLAR': 'Lead', // A41 Bass Clarinet
  'Juno106_Factory/ENG HORN': 'Lead', // A42 English Horn
  'Juno106_Factory/BRASSENS': 'Brass', // A43 Brass Ensemble
  'Juno106_Factory/GUITAR': 'Keys', // A44 Guitar
  'Juno106_Factory/KOTO': 'Keys', // A45 Koto
  'Juno106_Factory/DARKPLUC': 'Pluck & Stab', // A46 Dark Pluck
  'Juno106_Factory/FUNKY I': 'Pluck & Stab', // A47 Funky I
  'Juno106_Factory/SYNTHBAS': 'Bass', // A48 Synth Bass I
  'Juno106_Factory/LEAD I': 'Lead', // A51 Lead I
  'Juno106_Factory/LEAD II': 'Lead', // A52 Lead II
  'Juno106_Factory/LEAD III': 'Lead', // A53 Lead III
  'Juno106_Factory/FUNKY II': 'Pluck & Stab', // A54 Funky II
  'Juno106_Factory/SYNTHBA2': 'Bass', // A55 Synth Bass II
  'Juno106_Factory/FUNKYIII': 'Pluck & Stab', // A56 Funky III
  'Juno106_Factory/THUD WAH': 'Bass', // A57 Thud Wah
  'Juno106_Factory/GOING UP': 'FX & Noise', // A58 Going Up
  'Juno106_Factory/PIANO II': 'Keys', // A61 Piano II
  'Juno106_Factory/CLAV.': 'Keys', // A62 Clav.
  'Juno106_Factory/FRONTIER': 'Organ', // A63 Frontier Organ
  'Juno106_Factory/SNAREDRU': 'Drums & Hits', // A64 Snare Drum
  'Juno106_Factory/TOM TOMS': 'Drums & Hits', // A65 Tom Toms
  'Juno106_Factory/TIMPANI': 'Drums & Hits', // A66 Timpani
  'Juno106_Factory/SHAKER': 'Drums & Hits', // A67 Shaker
  'Juno106_Factory/SYNTHPAD': 'Pad', // A68 Synth Pad
  'Juno106_Factory/SWEEP I': 'FX & Noise', // A71 Sweep I
  'Juno106_Factory/PLUCKSWE': 'Pluck & Stab', // A72 Pluck Sweep
  'Juno106_Factory/REPEATER': 'Pluck & Stab', // A73 Repeater
  'Juno106_Factory/SWEEP II': 'FX & Noise', // A74 Sweep II
  'Juno106_Factory/PLUCKBEL': 'Bells & Mallets', // A75 Pluck Bell
  'Juno106_Factory/DARKSYNT': 'Keys', // A76 Dark Synth Piano
  'Juno106_Factory/SUSTAINE': 'Pad', // A77 Sustainer
  'Juno106_Factory/WAHRELEA': 'Pluck & Stab', // A78 Wah Release
  'Juno106_Factory/GONG': 'Bells & Mallets', // A81 Gong
  'Juno106_Factory/RESONANC': 'Pluck & Stab', // A82 Resonance Funk
  'Juno106_Factory/DRUMBOOM': 'Drums & Hits', // A83 Drum Booms
  'Juno106_Factory/DUSTSTOR': 'FX & Noise', // A84 Dust Storm
  'Juno106_Factory/ROCKETME': 'FX & Noise', // A85 Rocket Men
  'Juno106_Factory/HANDCLAP': 'Drums & Hits', // A86 Hand Claps
  'Juno106_Factory/FX SWEEP': 'FX & Noise', // A87 FX Sweep
  'Juno106_Factory/CAVERNS': 'FX & Noise', // A88 Caverns
  'Juno106_Factory/STRNG': 'Strings', // B11 Strings
  'Juno106_Factory/VIOLIN': 'Strings', // B12 Violin
  'Juno106_Factory/CHORUSVI': 'Bells & Mallets', // B13 Chorus Vibes
  'Juno106_Factory/ORGAN I2': 'Organ', // B14 Organ I
  'Juno106_Factory/HRPSCD I': 'Keys', // B15 Harpsichord I
  'Juno106_Factory/RECORDER': 'Lead', // B16 Recorder
  'Juno106_Factory/PERC.PLU': 'Pluck & Stab', // B17 Perc. Pluck
  'Juno106_Factory/NOISESWE': 'FX & Noise', // B18 Noise Sweep
  'Juno106_Factory/SPACECHI': 'Bells & Mallets', // B21 Space Chimes
  'Juno106_Factory/NYLONGUI': 'Keys', // B22 Nylon Guitar
  'Juno106_Factory/ORCHESTR': 'Strings', // B23 Orchestral Pad
  'Juno106_Factory/BRIGHTPL': 'Pluck & Stab', // B24 Bright Pluck
  'Juno106_Factory/ORGANBEL': 'Organ', // B25 Organ Bell
  'Juno106_Factory/ACCORDIO': 'Organ', // B26 Accordion
  'Juno106_Factory/FXRISE1': 'FX & Noise', // B27 FX Rise 1
  'Juno106_Factory/FXRISE2': 'FX & Noise', // B28 FX Rise 2
  'Juno106_Factory/BRASS2': 'Brass', // B31 Brass
  'Juno106_Factory/HELICOPT': 'FX & Noise', // B32 Helicopter
  'Juno106_Factory/LUTE': 'Keys', // B33 Lute
  'Juno106_Factory/CHORUSFU': 'Pluck & Stab', // B34 Chorus Funk
  'Juno106_Factory/TOMITA': 'FX & Noise', // B35 Tomita
  'Juno106_Factory/FXSWEEP1': 'FX & Noise', // B36 FX Sweep 1
  'Juno106_Factory/SHARPREE': 'Lead', // B37 Sharp Reed
  'Juno106_Factory/BASSPLUC': 'Bass', // B38 Bass Pluck
  'Juno106_Factory/RESONANT': 'FX & Noise', // B41 Resonant Rise
  'Juno106_Factory/HRPSCD 2': 'Keys', // B42 Harpsichord 2
  'Juno106_Factory/DARKENSE': 'Pad', // B43 Dark Ensemble
  'Juno106_Factory/CONTACTW': 'FX & Noise', // B44 Contact Wah
  'Juno106_Factory/NOISESW2': 'FX & Noise', // B45 Noise Sweep 2
  'Juno106_Factory/GLASSYWA': 'Pad', // B46 Glassy Wah
  'Juno106_Factory/PHASEENS': 'Pad', // B47 Phase Ensemble
  'Juno106_Factory/CHORUSED': 'Bells & Mallets', // B48 Chorused Bell
  'Juno106_Factory/CLAV': 'Keys', // B51 Clav
  'Juno106_Factory/ORGAN 2': 'Organ', // B52 Organ 2
  'Juno106_Factory/BASSOON': 'Lead', // B53 Bassoon
  'Juno106_Factory/AUTORELE': 'FX & Noise', // B54 Auto Release Noise Sweep
  'Juno106_Factory/BRASSEN2': 'Brass', // B55 Brass Ensemble
  'Juno106_Factory/ETHEREAL': 'Pad', // B56 Ethereal
  'Juno106_Factory/CHORUSBE': 'Bells & Mallets', // B57 Chorus Bell 2
  'Juno106_Factory/BLIZZARD': 'FX & Noise', // B58 Blizzard
  'Juno106_Factory/E.PIANOW': 'Keys', // B61 E. Piano with Tremolo
  'Juno106_Factory/CLARINET': 'Lead', // B62 Clarinet
  'Juno106_Factory/THUNDER': 'FX & Noise', // B63 Thunder
  'Juno106_Factory/REEDYORG': 'Organ', // B64 Reedy Organ
  'Juno106_Factory/FLUTE-HO': 'Lead', // B65 Flute - Horn
  'Juno106_Factory/TOYRHODE': 'Keys', // B66 Toy Rhodes
  'Juno106_Factory/SURFS UP': 'FX & Noise', // B67 Surf's Up
  'Juno106_Factory/OW BASS': 'Bass', // B68 OW Bass
  'Juno106_Factory/PICCOLO': 'Lead', // B71 Piccolo
  'Juno106_Factory/MELODICT': 'Lead', // B72 Melodic Taps
  'Juno106_Factory/MEOWBASS': 'Bass', // B73 Meow Bass
  'Juno106_Factory/VIOLINHI': 'Strings', // B74 Violin (high)
  'Juno106_Factory/HIGHBELL': 'Bells & Mallets', // B75 High Bells
  'Juno106_Factory/ROLLINGW': 'Pad', // B76 Rolling Wah
  'Juno106_Factory/PINGBELL': 'Bells & Mallets', // B77 Ping Bell
  'Juno106_Factory/BRASSYOR': 'Brass', // B78 Brassy Organ
  'Juno106_Factory/LOWDARKS': 'Strings', // B81 Low Dark Strings
  'Juno106_Factory/PICCOLOT': 'Brass', // B82 Piccolo Trumpet
  'Juno106_Factory/CELLO': 'Strings', // B83 Cello
  'Juno106_Factory/HIGHSTR2': 'Strings', // B84 High Strings
  'Juno106_Factory/ROCKETM2': 'FX & Noise', // B85 Rocket Men
  'Juno106_Factory/FORBIDDE': 'FX & Noise', // B86 Forbidden Planet
  'Juno106_Factory/FROGGY': 'FX & Noise', // B87 Froggy
  'Juno106_Factory/OWGAN': 'Organ', // B88 Owgan

  // Korg Polysix setting charts converted by tools/polysix/convert.mjs
  'Polysix_Charts/BRASS': 'Brass', // series 1 A-1 Brass
  'Polysix_Charts/STR': 'Strings', // series 1 A-2 Strings
  'Polysix_Charts/E. PNO 1': 'Keys', // series 1 A-3 Electric Piano 1
  'Polysix_Charts/CLAVI': 'Keys', // series 1 A-4 Clavi
  'Polysix_Charts/AC PIANO': 'Keys', // series 1 A-5 Acoustic Piano
  'Polysix_Charts/ORG 1': 'Organ', // series 1 A-6 Organ 1
  'Polysix_Charts/MOON SND': 'FX & Noise', // series 1 A-7 Moon Sound
  'Polysix_Charts/VIBES': 'Bells & Mallets', // series 1 A-8 Vibes
  'Polysix_Charts/SYN ORG': 'Organ', // series 1 B-1 Synthe Organ
  'Polysix_Charts/HIGH STR': 'Strings', // series 1 B-2 High Strings
  'Polysix_Charts/FAT SOLO': 'Lead', // series 1 B-3 Fat Solo Sound
  'Polysix_Charts/SAXOPHON': 'Brass', // series 1 B-4 Saxophone
  'Polysix_Charts/FLUTE': 'Lead', // series 1 B-5 Flute
  'Polysix_Charts/TROMBONE': 'Brass', // series 1 B-6 Trombone
  'Polysix_Charts/GUITAR': 'Keys', // series 1 B-7 Guitar
  'Polysix_Charts/HONKYTNK': 'Keys', // series 1 B-8 Honky Tonk Piano
  'Polysix_Charts/LEAD SND': 'Lead', // series 1 C-1 Lead Sound
  'Polysix_Charts/FAT BASS': 'Bass', // series 1 C-2 Fat Bass
  'Polysix_Charts/REGGAE': 'Pluck & Stab', // series 1 C-3 Reggae Sound
  'Polysix_Charts/BANJO': 'Keys', // series 1 C-4 Banjo
  'Polysix_Charts/E. PNO 2': 'Keys', // series 1 C-5 Electric Piano 2
  'Polysix_Charts/FILTCLAV': 'Keys', // series 1 C-6 Filtered Clavi
  'Polysix_Charts/NEWWAVOR': 'Organ', // series 1 C-7 New Wave Organ
  'Polysix_Charts/JAZZ GTR': 'Keys', // series 1 C-8 Jazz Guitar
  'Polysix_Charts/UNI LOW': 'Lead', // series 1 D-1 Unison Solo Low
  'Polysix_Charts/UNI HIGH': 'Lead', // series 1 D-2 Unison Solo High
  'Polysix_Charts/ORG 2': 'Organ', // series 1 D-3 Organ 2
  'Polysix_Charts/CHIME': 'Bells & Mallets', // series 1 D-4 Chime with Chord Memory
  'Polysix_Charts/SND FALL': 'FX & Noise', // series 1 D-5 Sound Fall
  'Polysix_Charts/THIN SND': 'Synth', // series 1 D-6 Thin Sound
  'Polysix_Charts/TOUCH': 'Lead', // series 1 D-7 "Touch" Sound
  'Polysix_Charts/KIMCARNE': 'Lead', // series 1 D-8 Kim Carne's Sound
  'Polysix_Charts/BRASSENS': 'Brass', // series 2 A-1 Brass Ensemble
  'Polysix_Charts/MELLOWBR': 'Brass', // series 2 A-2 Mellow Brass
  'Polysix_Charts/OBOE': 'Lead', // series 2 A-3 Oboe
  'Polysix_Charts/FLUTE2': 'Lead', // series 2 A-4 Flute
  'Polysix_Charts/STR ORCH': 'Strings', // series 2 A-5 Strings Orchestra
  'Polysix_Charts/VIOLIN': 'Strings', // series 2 A-6 Solo Violin
  'Polysix_Charts/BOW STR': 'Strings', // series 2 A-7 Bowing Strings
  'Polysix_Charts/KOTO': 'Keys', // series 2 A-8 Koto
  'Polysix_Charts/E. PNO': 'Keys', // series 2 B-1 Electric Piano
  'Polysix_Charts/ORG SLOW': 'Organ', // series 2 B-2 Organ (Slow)
  'Polysix_Charts/ORG FAST': 'Organ', // series 2 B-3 Organ (Fast)
  'Polysix_Charts/HARPSICH': 'Keys', // series 2 B-4 Harpsichord
  'Polysix_Charts/CLAVI2': 'Keys', // series 2 B-5 Clavi
  'Polysix_Charts/CHOIR F': 'Pad', // series 2 B-6 Chorus (Female)
  'Polysix_Charts/CHOIR M': 'Pad', // series 2 B-7 Chorus (Male)
  'Polysix_Charts/STM PIPE': 'Organ', // series 2 B-8 Steam Pipe Organ
  'Polysix_Charts/SYN 1': 'Synth', // series 2 C-1 Synthe 1
  'Polysix_Charts/SYN 2': 'Synth', // series 2 C-2 Synthe 2
  'Polysix_Charts/SYN 3': 'Synth', // series 2 C-3 Synthe 3
  'Polysix_Charts/SLOW WAH': 'Synth', // series 2 C-4 Slow Attack Wah-Wah
  'Polysix_Charts/SYN BASS': 'Bass', // series 2 C-5 Synthe Bass
  'Polysix_Charts/SYN 4': 'Synth', // series 2 C-6 Synthe 4
  'Polysix_Charts/ORIENTAL': 'FX & Noise', // series 2 C-7 Oriental Sound
  'Polysix_Charts/SYN HARP': 'Keys', // series 2 C-8 Synthe Harp
  'Polysix_Charts/WHISTLE': 'Lead', // series 2 D-1 Whistle
  'Polysix_Charts/SFX 1': 'FX & Noise', // series 2 D-2 Sound Effect 1
  'Polysix_Charts/GAMBANG': 'Bells & Mallets', // series 2 D-3 Gambang
  'Polysix_Charts/SFX 2': 'FX & Noise', // series 2 D-4 Sound Effect 2
  'Polysix_Charts/SFX 3': 'FX & Noise', // series 2 D-5 Sound Effect 3
  'Polysix_Charts/CAVEECHO': 'FX & Noise', // series 2 D-6 Cave Echo
  'Polysix_Charts/SFX 4': 'FX & Noise', // series 2 D-7 Sound Effect 4
  'Polysix_Charts/SFX 5': 'FX & Noise', // series 2 D-8 Sound Effect 5

  // Moog Minimoog Sound Charts converted by tools/minimoog/convert.mjs
  'Minimoog_Charts/BALALAIK': 'Keys', // Balalaika (Mandolin)
  'Minimoog_Charts/E.GUITAR': 'Bass', // Electric Guitar, Bass/Treble
  'Minimoog_Charts/HARPSICH': 'Keys', // Harpsichord
  'Minimoog_Charts/SHAMISEN': 'Keys', // Shamisen (Chinese plucked instrument)
  'Minimoog_Charts/VIOLIN': 'Strings', // Violin
  'Minimoog_Charts/E. PIANO': 'Keys', // Electric Piano
  'Minimoog_Charts/CELLO': 'Strings', // Cello
  'Minimoog_Charts/VIOLA': 'Strings', // Viola
  'Minimoog_Charts/BASSPLUK': 'Bass', // Bass Viol, Plucked
  'Minimoog_Charts/BASS BOW': 'Bass', // Bass Viol, Bowed
  'Minimoog_Charts/FLUTE': 'Lead', // Flute
  'Minimoog_Charts/PICCOLO': 'Lead', // Piccolo
  'Minimoog_Charts/CLARINET': 'Lead', // Clarinet (Bass Clarinet)
  'Minimoog_Charts/RECORDER': 'Lead', // Recorder Family
  'Minimoog_Charts/BASSOON': 'Lead', // Bassoon (English Horn)
  'Minimoog_Charts/OBOE': 'Lead', // Oboe
  'Minimoog_Charts/HORN': 'Brass', // Horn
  'Minimoog_Charts/TRUMPET': 'Brass', // Trumpet
  'Minimoog_Charts/TUBA': 'Brass', // Tuba
  'Minimoog_Charts/TROMBONE': 'Brass', // Trombone (Jazz)
  'Minimoog_Charts/TMPLBLCK': 'Drums & Hits', // Temple Blocks
  'Minimoog_Charts/XYLOPHON': 'Bells & Mallets', // Xylophone
  'Minimoog_Charts/BASSDRUM': 'Drums & Hits', // Bass Drum
  'Minimoog_Charts/DRUMROLL': 'Drums & Hits', // Drum Roll
  'Minimoog_Charts/AQUATARK': 'Lead', // Emerson, Lake, and Palmer's Aquatarkus, from Tarkus
  'Minimoog_Charts/TINKLBEL': 'Bells & Mallets', // Tinkling Bells
  'Minimoog_Charts/FAT BASS': 'Bass', // Emerson's Fat Bass from Brain Salad Surgery
  'Minimoog_Charts/TRILOGY': 'Lead', // Emerson, Lake and Palmer's Trilogy
  'Minimoog_Charts/CATHERIN': 'Lead', // Rick Wakeman's Catherine of Aragon
  'Minimoog_Charts/ELPSTEEL': 'Bells & Mallets', // Emerson's Steel Drum from Brain Salad Surgery
  'Minimoog_Charts/GOOM': 'Lead', // Goom
  'Minimoog_Charts/GOOD SND': 'Lead', // Good Sound
  'Minimoog_Charts/TLR SND': 'Lead', // The T.L.R. Sound
  'Minimoog_Charts/MOOG SND': 'Lead', // The Moog Sound
  'Minimoog_Charts/HINDEMOG': 'Lead', // Hindemoog
  'Minimoog_Charts/MOONCHRD': 'Pad', // Moon Chord
  'Minimoog_Charts/RING MOD': 'FX & Noise', // Ring Modulator Effects
  'Minimoog_Charts/BADINGS': 'Pad', // Hommage a Badings
  'Minimoog_Charts/RUN RHYT': 'Arp & Sequence', // Running Rhythm
  'Minimoog_Charts/VREE OO': 'FX & Noise', // Vree Oo Bleep-Bleep
  'Minimoog_Charts/JETPLANE': 'FX & Noise', // Jet Plane
  'Minimoog_Charts/NIGHTCRT': 'FX & Noise', // Night Creatures
  'Minimoog_Charts/THUNDER': 'FX & Noise', // Thunder
  'Minimoog_Charts/SURF': 'FX & Noise', // Surf
  'Minimoog_Charts/BOMB': 'FX & Noise', // Exploding Bomb
  'Minimoog_Charts/WIND': 'FX & Noise', // Wind
  'Minimoog_Charts/WHISTLER': 'FX & Noise', // Whistlers
  'Minimoog_Charts/SIREN': 'FX & Noise', // Siren
  'Minimoog_Charts/STEELDRU': 'Bells & Mallets', // Steel Drum
};
