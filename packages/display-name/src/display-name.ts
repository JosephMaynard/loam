export interface WordPack {
  adjectives: readonly string[];
  materials: readonly string[];
  creatures: readonly string[];
}

export interface DisplayNameParts {
  adjective: string;
  material: string;
  creature: string;
}

const adjectives = [
  "amber","ancient","arcane","autumn","bitter","black","blazing","bleak","blessed","bold","brave","bright",
  "brisk","broken","bronze","calm","careful","cedar","charred","chill","clear","clever","cloudy","coastal",
  "cold","copper","crimson","crooked","crystal","curious","dapper","dark","dawn","deep","dense","distant",
  "dusty","eager","ember","even","faded","fancy","fern","fierce","fine","flint","floral","flying",
  "foggy","forged","frozen","gentle","ghostly","glassy","golden","granite","grave","green","grey","hidden",
  "hollow","honey","icy","iron","jagged","jasper","kind","laced","lake","light","lively","lone",
  "lucky","lunar","marble","meadow","mellow","midnight","mild","misty","mossy","murky","narrow","navy",
  "nimble","noble","north","odd","olden","olive","onyx","opal","orange","pale","pearl","pine",
  "plum","polished","proud","quiet","rapid","rare","raven","red","restless","river","rocky","rosy",
  "rough","royal","sable","sacred","sage","salt","scarlet","secret","silver","slate","small","smoky",
  "snowy","soft","solar","southern","spring","still","stone","stormy","summer","swift","tender","tidal",
  "timber","tiny","topaz","true","twilight","umber","velvet","verdant","violet","warm","waxen","western",
  "white","wild","windy","winter","wooden","woven","young","zesty",
] as const;

const materials = [
  "agate","alder","alloy","amber","ash","aspen","basalt","beacon","birch","bloom","bluff","boulder",
  "bramble","briar","bronze","brook","cairn","canopy","canyon","cedar","chalk","cinder","clay","cliff",
  "cloud","coast","cobalt","copper","coral","cove","crag","creek","crystal","dawn","delta","dune",
  "ebony","echo","elm","ember","fern","field","fire","fjord","flame","flood","foam","fog",
  "forest","forge","frost","garden","glass","glen","glow","granite","grove","harbor","haze","hearth",
  "heather","hickory","hollow","ice","ink","iron","isle","ivory","jade","jet","juniper","lake",
  "lava","leaf","linen","marble","marsh","meadow","mesa","mist","moon","moss","night","north",
  "oak","ocean","onyx","opal","orchard","ore","paper","pearl","pine","plains","quartz","rain",
  "reed","ridge","river","rose","rust","sand","satin","sea","shadow","shell","shore","silk",
  "silver","sky","slate","smoke","snow","soil","spark","spring","spruce","star","steel","stone",
  "storm","stream","summer","sun","surf","tar","thicket","thorn","timber","tide","topaz","vale",
  "velvet","vine","walnut","water","wave","willow","wind","wood",
] as const;

const creatures = [
  "adder","antler","badger","bat","beacon","bear","beetle","bison","boar","bobcat","buffalo","bunting",
  "canary","caribou","cat","cicada","condor","corgi","cougar","coyote","crane","crow","deer","dingo",
  "dolphin","dove","dragon","duck","eagle","eel","egret","elk","ermine","falcon","ferret","finch",
  "firefly","fox","frog","gecko","gibbon","glider","goose","grouse","gull","hare","hawk","heron",
  "herring","honeybee","hound","ibis","impala","jackal","jaguar","jay","kestrel","kingfisher","kite","koala",
  "kraken","lapwing","lark","lemur","leopard","lion","loon","lynx","magpie","mallard","marten","mink",
  "minnow","mole","moose","moth","narwhal","newt","nightjar","ocelot","orca","otter","owl","panther",
  "parrot","pebble","pelican","phoenix","pika","puffin","puma","quail","rabbit","raccoon","ram","raven",
  "rook","sable","salmon","seal","serpent","shark","shearwater","sparrow","spider","stag","starling","stork",
  "swift","tern","thrush","tiger","toad","trout","turaco","turtle","viper","vole","wasp","weasel",
  "whale","wildcat","wolf","wren","yak",
] as const;

export const englishWordPack: WordPack = {
  adjectives,
  materials,
  creatures,
};

const cacheByPack = new WeakMap<WordPack, Map<string, DisplayNameParts>>();

function getCache(pack: WordPack): Map<string, DisplayNameParts> {
  let cache = cacheByPack.get(pack);

  if (!cache) {
    cache = new Map();
    cacheByPack.set(pack, cache);
  }

  return cache;
}

function assertPack(pack: WordPack): void {
  if (!pack.adjectives.length || !pack.materials.length || !pack.creatures.length) {
    throw new Error("Display name word packs must provide non-empty adjectives, materials, and creatures.");
  }
}

function mix32(value: number): number {
  let mixed = value >>> 0;
  mixed ^= mixed >>> 16;
  mixed = Math.imul(mixed, 0x7feb352d);
  mixed ^= mixed >>> 15;
  mixed = Math.imul(mixed, 0x846ca68b);
  mixed ^= mixed >>> 16;
  return mixed >>> 0;
}

export function hashString(value: string): number {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

function pickWord(seed: number, words: readonly string[]): string {
  return words[seed % words.length];
}

export function getDisplayNameParts(id: string, pack: WordPack = englishWordPack): DisplayNameParts {
  assertPack(pack);
  const cache = getCache(pack);
  const cached = cache.get(id);

  if (cached) {
    return cached;
  }

  const seed = hashString(id);
  const parts: DisplayNameParts = {
    adjective: pickWord(mix32(seed ^ 0x1f123bb5), pack.adjectives),
    material: pickWord(mix32(seed ^ 0x8f3a2c19), pack.materials),
    creature: pickWord(mix32(seed ^ 0x36d2e9b1), pack.creatures),
  };

  cache.set(id, parts);
  return parts;
}

export function generateDisplayName(id: string, pack: WordPack = englishWordPack): string {
  const parts = getDisplayNameParts(id, pack);
  return `${parts.adjective}.${parts.material}.${parts.creature}`;
}
