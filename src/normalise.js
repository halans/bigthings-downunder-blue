'use strict';
/**
 * Domain normalisation: sizes → metres, years → integers, notes → status,
 * names → playful categories. Every function keeps the original string so
 * nothing is lost when a value can't be parsed.
 */

const { findTemplates, toPlainText } = require('./wikitext');

const UNIT_TO_M = { m: 1, metre: 1, metres: 1, meter: 1, meters: 1, cm: 0.01, mm: 0.001, km: 1000, ft: 0.3048, feet: 0.3048, foot: 0.3048, in: 0.0254, inch: 0.0254, inches: 0.0254 };

/**
 * Parse a Size cell into { raw, heightM, dimsM[], text }.
 * Handles {{convert|13|*|5|m|ft}}, "8 m (26 ft)", "15×18 m", "3 m tall",
 * "10-foot-high (3.0 m)", and free prose with an embedded measurement.
 */
function parseSize(rawCell) {
  const raw = (rawCell || '').trim();
  const result = { raw, text: toPlainText(raw) || null, dimsM: [], heightM: null, lengthM: null, sizeMaxM: null, sizeKind: 'unknown' };
  if (!raw) return result;

  const nums = [];
  let unit = null;

  for (const t of [...findTemplates(raw, 'convert'), ...findTemplates(raw, 'cvt')]) {
    const p = t.params.filter((x) => !x.includes('='));
    for (const item of p) {
      if (/^[\d.]+$/.test(item)) nums.push(parseFloat(item));
      else if (item === '*' || item === 'x' || item === 'by' || item === '×') continue;
      else if (UNIT_TO_M[item.toLowerCase()]) { unit = item.toLowerCase(); break; }
      else break;
    }
    if (nums.length) break;
  }

  if (!nums.length) {
    // "15×18 m", "13 x 5 m", "8 m", "2.4x3.5 m"
    const m = /([\d.]+)\s*(?:[×x*]\s*([\d.]+))?\s*(?:[×x*]\s*([\d.]+))?\s*(m|metres?|meters?|cm|mm|km|ft|feet|foot|in|inches)\b/i.exec(raw);
    if (m) {
      for (let i = 1; i <= 3; i++) if (m[i]) nums.push(parseFloat(m[i]));
      unit = m[4].toLowerCase();
    }
  }
  if (!nums.length) {
    // "10-foot-high (3.0 m)" — prefer the metric value in parens
    const m = /\(\s*([\d.]+)\s*(m|metres?)\s*\)/i.exec(raw);
    if (m) { nums.push(parseFloat(m[1])); unit = 'm'; }
  }
  if (!nums.length || !unit) return result;

  const f = UNIT_TO_M[unit] || 1;
  result.dimsM = nums.map((n) => round(n * f, 3));
  result.sizeMaxM = Math.max(...result.dimsM);

  // The source article is inconsistent about which axis it quotes, so only
  // claim a height when the prose actually says so. The Giant Worm is 250 m
  // LONG, not 250 m tall — conflating the two invents world records.
  const saysLong = /\b(long|length|wide|width|wingspan|diameter|across)\b/i.test(raw);
  const saysTall = /\b(tall|high|height)\b/i.test(raw);
  if (saysTall) {
    result.sizeKind = 'height';
    result.heightM = result.dimsM[0];
  } else if (saysLong) {
    result.sizeKind = 'length';
    result.lengthM = result.sizeMaxM;
    if (result.dimsM.length > 1) result.heightM = Math.min(...result.dimsM);
  } else if (result.dimsM.length === 1) {
    // A single bare measurement in this article is conventionally the height.
    result.sizeKind = 'height';
    result.heightM = result.dimsM[0];
  } else {
    result.sizeKind = 'dimensions';
  }
  return result;
}

/** Parse a Built cell into { raw, year, circa, text }. */
function parseBuilt(rawCell) {
  const raw = (rawCell || '').trim();
  const text = toPlainText(raw) || null;
  const out = { raw, text, year: null, circa: false };
  if (!raw) return out;
  if (/\bc\.?\s?\d{4}|\bcirca\b|\babout\b|\bearly\b|\blate\b|\bmid[- ]/i.test(text || '')) out.circa = true;
  const years = (text || '').match(/\b(1[89]\d{2}|20[0-4]\d)\b/g);
  if (years && years.length) out.year = parseInt(years[0], 10);
  return out;
}

const STATUS_RULES = [
  { status: 'demolished', re: /\b(demolished|pulled down|destroyed|torn down|dismantled|burnt down|burned down|no longer exists|was removed and (?:destroyed|scrapped)|scrapped)\b/i },
  { status: 'removed', re: /\b(removed|no longer there|no longer stands|is no longer|has been taken down|taken down|was sold|in storage|retired|disassembled|taken apart|pulled apart|put into storage)\b/i },
  { status: 'relocated', re: /\b(relocated|moved to|was moved|now resides|now located|transported to)\b/i },
  // Refurbishment deliberately does NOT live here: a repainted, restored or
  // refurbished big thing is still the same big thing, still standing.
  { status: 'replaced', re: /\b(replaced|rebuilt|remodelled|remodeled)\b/i },
];

/**
 * Subordinating conjunctions that introduce a clause about something else.
 *
 * "since" and "while" are only subordinating when they are not doing adverbial
 * duty after an auxiliary — "the business has SINCE moved and disassembled it"
 * is one clause about our sculpture, and cutting at "since" threw away the
 * only word that said it was gone.
 */
const SUBORDINATE = /\b(?<!(?:has|have|had|having|is|was|were|been)\s)(after|although|though|whereas|while|because|since|whilst|gaining this title|which had|see )\b/i;

/**
 * Trim a sentence to its main clause. "It is the world's largest pineapple,
 * gaining this title after a water tower in Hawaii was dismantled in 1993"
 * must not mark the pineapple as dismantled — the demolition belongs to the
 * subordinate clause's subject, not ours.
 */
function mainClause(sentence) {
  const m = SUBORDINATE.exec(sentence);
  return m ? sentence.slice(0, m.index) : sentence;
}

/**
 * Infer a lifecycle status from the Notes prose, keeping the sentence that
 * justified it. Precedence: demolished > removed > relocated > replaced >
 * standing. Only main clauses are considered.
 */
function inferStatus(notesText) {
  const text = notesText || '';
  const sentences = text.split(/(?<=[.!?;])\s+/).filter(Boolean);
  for (const rule of STATUS_RULES) {
    for (const s of sentences) {
      if (rule.re.test(mainClause(s))) return { status: rule.status, evidence: s.trim() };
    }
  }
  return { status: 'standing', evidence: null };
}

const CATEGORY_RULES = [
  ['fruit-and-veg', /\b(banana|apple|orange|pineapple|mango|cherry|cherries|lemon|mandarin|melon|watermelon|strawberr|avocado|potato|pumpkin|tomato|onion|carrot|corn|olive|grape|peach|pear|fig|kiwi|passionfruit|coconut|durian|fruit|veg|mushroom|acorn|nut|macadamia|almond|peanut|chestnut|bean|pea\b|asparagus|garlic|beetroot|cabbage|lettuce|zucchini|capsicum|chilli|pepper|apricot|plum|nectarine|blueberr|raspberr|lime\b|grapefruit|papaya|pawpaw|guava|lychee|persimmon|quince|rhubarb|spud|swede|turnip|yam|cauliflower|brussels sprout|sprout|strawberry)\b/i],
  ['seafood', /\b(prawn|lobster|crab|oyster|fish|barramundi|murray cod|trout|marlin|shark|squid|crayfish|yabby|yabbie|mussel|scallop|abalone|shell|shrimp|tuna|salmon|snapper|whiting|bream|flathead|eel|octopus|clam|periwinkle|pipi|cockle)\b/i],
  ['fauna', /\b(koala|kangaroo|wombat|platypus|echidna|emu|galah|magpie|kookaburra|penguin|pelican|cassowary|brolga|owl|eagle|parrot|cockatoo|budgie|swan|duck|goose|chicken|rooster|hen\b|turkey|pheasant|peacock|dog|dingo|blue heeler|cat\b|horse|pony|cow|bull|calf|sheep|ram\b|lamb|merino|ewe|goat|pig\b|boar|buffalo|camel|donkey|mule|deer|rabbit|mouse|rat\b|possum|bat\b|snake|lizard|goanna|crocodile|croc\b|turtle|tortoise|frog|toad|cane toad|ant\b|bee\b|beetle|butterfly|moth|mosquito|mozzie|cockroach|spider|scorpion|fly\b|worm|slug|snail|dinosaur|diplodocus|triceratops|tyrannosaur|stegosaur|bunyip|dragon|whale|dolphin|dugong|seal\b|sea lion|bird|elephant|giraffe|lion|tiger|bear|gorilla|monkey|zebra|rhino|hippo|panda|wallaby|quokka|numbat|bilby|thylacine|tasmanian devil|stockman|drover|thorny devil|mantis|mantid|redback|funnel web|bogong|alpaca|llama|seagull|honeyeater|lyrebird|brumby|bandicoot|clownfish|kingfisher|numbat|goanna)\b/i],
  ['food-and-drink', /\b(pie\b|pav|pavlova|cake|milkshake|ice ?cream|cone\b|burger|hot dog|sausage|chip|donut|doughnut|cheese|butter|egg\b|bread|loaf|pizza|coffee|cup\b|teapot|beer|stubby|can\b|bottle|barrel|cask|wine|keg|schooner|glass\b|rum\b|whisky|honey|jam\b|sauce|chocolate|lolly|lollipop|sweet|biscuit|pastry|cheesecake|meat|steak|ham\b|bacon|noodle|rice\b|flour|sugar|salt\b|pepper mill|kettle|mug\b|thermos|esky|bbq|barbecue|lamington|vegemite|weet|wine|milkshake|sardine|pie\b)\b/i],
  ['machinery-and-transport', /\b(tractor|truck|lorry|car\b|ute\b|motorcycle|motorbike|bike|bicycle|trike|train|locomotive|engine|plane|aeroplane|aircraft|jet\b|helicopter|boat|ship|yacht|canoe|kayak|windmill|winch|pump|drill|excavator|bulldozer|crane|wheel|tyre|tire|propeller|anchor|caravan|bus\b|tram|rocket|satellite|dray|wagon|cart|plough|plow|harvester|header|shearing|mower|chainsaw|generator|turbine|dozer|grader|loader|forklift|digger)\b/i],
  ['tools-and-industry', /\b(axe\b|pick\b|shovel|spade|hammer|spanner|wrench|screwdriver|saw\b|nail\b|screw\b|bolt\b|nut and bolt|drill bit|lamp\b|lantern|torch|miner|mining|gold pan|panner|nugget|ingot|bucket|barrow|ladder|peg\b|clothes ?peg|pin\b|needle|scissors|knife|fork\b|spoon|tap\b|valve|pipe\b|gear|cog|magnet|battery|globe|bulb|switch|wire|cable|chain|rope|net\b|trap\b|anvil|forge|bellows|kiln|silo|tank\b|dam\b|bridge|tower|chimney|stack\b|wool|bale|windrow|fleece)\b/i],
  ['sport-and-leisure', /\b(cricket|bat\b|stump|golf|ball\b|tennis|racquet|racket|football|footy|soccer|basketball|bowl\b|bowling|billiard|pool ball|eight ball|8 ?ball|dart|boxing|glove|surfboard|skateboard|swing|slide\b|playground|chess|domino|deck of cards|trophy|medal|whistle|jersey|boot\b|ugg|shoe|thong|hat\b|akubra|helmet|bicycle helmet|fishing rod|rod\b|reel\b|lure\b|kite|yo-?yo|marble|jigsaw|rubik)\b/i],
  ['people-and-culture', /\b(scotsman|santa|father christmas|ned kelly|captain|soldier|digger\b|swagman|miner\b|fisherman|farmer|nun\b|monk|priest|angel|buddha|jesus|mary\b|statue of|man\b|woman|lady|girl|boy\b|baby|family|head\b|face\b|hand\b|foot\b|thumb|book|bible|pen\b|pencil|paintbrush|guitar|violin|piano|drum|trumpet|didgeridoo|banjo|accordion|record player|jukebox|boomerang|shield|spear|mask|totem|flag|coin|note\b|stamp|postbox|mailbox|letterbox|phone|camera|television|radio|clock|watch|sundial|thermometer|barometer|compass|telescope|microscope|periodic table|dna|abacus|calculator|typewriter|matchstick|cigar|cigarette|pipe smoking|joint\b|bong|doc marten|boomerang|thong|headphone|photo frame)\b/i],
];

/**
 * Singularise every word so plural names still classify. Without this, "The
 * Big Bogong Moths", "The Big Sunflowers" and "The Big Pine Cones" all fell
 * through to `oddity` because the rules match `\bmoth\b` and the trailing "s"
 * defeats the word boundary.
 */
function depluralise(text) {
  return String(text || '').replace(/\b([A-Za-z]{4,}?)(?:ies|es|s)\b/g, (whole, stem) => {
    if (/(is|us|ss)$/i.test(whole)) return whole;
    if (whole.toLowerCase().endsWith('ies')) return `${whole} ${stem}y`;
    return `${whole} ${stem}`;
  });
}

/** Assign a playful category from the name, falling back to the notes. */
function classify(name, notesText) {
  const hay = depluralise(name || '');
  for (const [cat, re] of CATEGORY_RULES) if (re.test(hay)) return cat;
  const hay2 = depluralise(((name || '') + ' ' + (notesText || '')).slice(0, 400));
  for (const [cat, re] of CATEGORY_RULES) if (re.test(hay2)) return cat;
  return 'oddity';
}

/** Bucket a year into a road-trip era. */
function era(year) {
  if (!year) return 'unknown';
  if (year < 1970) return 'pioneer (pre-1970)';
  if (year < 1985) return 'boom (1970s–early 80s)';
  if (year < 2000) return 'late century (1985–1999)';
  if (year < 2015) return 'revival (2000s–2014)';
  return 'modern (2015+)';
}

function round(n, dp) { const f = 10 ** dp; return Math.round(n * f) / f; }

/** Normalise a place string for fuzzy matching across sources. */
function slugPlace(s) {
  return (s || '').toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Normalise a big-thing name for dedup: drop articles, "the", "big". */
function slugName(s) {
  return slugPlace(s).replace(/^(the|a)\s+/, '').replace(/\s+/g, ' ').trim();
}

module.exports = { parseSize, parseBuilt, inferStatus, classify, depluralise, era, slugPlace, slugName, round, UNIT_TO_M, CATEGORY_RULES, STATUS_RULES };
