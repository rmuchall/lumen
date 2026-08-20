import {PageGeometry} from "../../web/src/page-geometry.ts";

function assertCondition(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const geometry = new PageGeometry();
geometry.reset(
  [
    {estimatedHeight: 100, id: "page-a"},
    {estimatedHeight: 200, id: "page-b"},
    {estimatedHeight: 300, id: "page-c"},
  ],
  1,
);

assertCondition(geometry.totalHeight() === 600, "initial total height is wrong");
assertCondition(geometry.heightBefore("page-b") === 100, "page prefix height is wrong");
assertCondition(geometry.pageAt(0) === "page-a", "first inverse lookup is wrong");
assertCondition(geometry.pageAt(100) === "page-b", "boundary inverse lookup is wrong");
assertCondition(geometry.pageAt(599) === "page-c", "terminal inverse lookup is wrong");

assertCondition(geometry.updateMeasurement({height: 250, id: "page-b", widthEpoch: 1}), "measurement was rejected");
assertCondition(geometry.totalHeight() === 650, "measurement did not update total height");
assertCondition(geometry.heightBefore("page-c") === 350, "measurement did not update the following page position");
assertCondition(
  !geometry.updateMeasurement({height: 400, id: "page-b", widthEpoch: 2}),
  "stale width measurement was accepted",
);

geometry.append([{estimatedHeight: 400, id: "page-d"}]);
assertCondition(geometry.totalHeight() === 1050, "appended page did not extend geometry");
assertCondition(geometry.pageAt(1049) === "page-d", "appended page inverse lookup is wrong");
const snapshot = geometry.snapshot();
assertCondition(snapshot.pageIds.join(",") === "page-a,page-b,page-c,page-d", "snapshot lost page order");

geometry.replace(
  [
    {estimatedHeight: 960, id: "page-a"},
    {estimatedHeight: 960, id: "page-b"},
    {estimatedHeight: 960, id: "page-c"},
    {estimatedHeight: 960, id: "page-d"},
    {estimatedHeight: 960, id: "page-e"},
  ],
  1,
);
assertCondition(geometry.heightForPage("page-b") === 250, "directory replacement lost a measured page height");
assertCondition(geometry.heightForPage("page-e") === 960, "directory replacement lost a new-page estimate");

geometry.beginWidthEpoch(2);
assertCondition(
  !geometry.updateMeasurement({height: 400, id: "page-b", widthEpoch: 1}),
  "old width measurement was accepted after a width epoch change",
);

let randomState = 0x6d2b79f5;
function nextRandom(): number {
  randomState = Math.imul(randomState ^ (randomState >>> 15), randomState | 1);
  randomState ^= randomState + Math.imul(randomState ^ (randomState >>> 7), randomState | 61);
  return (randomState ^ (randomState >>> 14)) >>> 0;
}

const randomizedPages = Array.from({length: 128}, (_, index) => ({
  estimatedHeight: 32 + (nextRandom() % 512),
  id: `random-${index}`,
}));
const randomizedGeometry = new PageGeometry();
randomizedGeometry.reset(randomizedPages, 1);
const expectedHeights = randomizedPages.map((page) => page.estimatedHeight);

for (let iteration = 0; iteration < 512; iteration += 1) {
  const index = nextRandom() % randomizedPages.length;
  const page = randomizedPages[index];
  if (page === undefined) {
    throw new Error("randomized page selection was out of bounds");
  }
  const height = 1 + (nextRandom() % 1024);
  const previousHeight = expectedHeights[index] ?? 0;
  assertCondition(
    randomizedGeometry.updateMeasurement({height, id: page.id, widthEpoch: 1}) === (previousHeight !== height),
    "randomized measurement acceptance diverged",
  );
  expectedHeights[index] = height;
  const expectedTotal = expectedHeights.reduce((total, value) => total + value, 0);
  assertCondition(randomizedGeometry.totalHeight() === expectedTotal, "randomized total height diverged");
  const position = nextRandom() % expectedTotal;
  let expectedIndex = 0;
  let covered = expectedHeights[0] ?? 0;
  while (position >= covered && expectedIndex + 1 < expectedHeights.length) {
    expectedIndex += 1;
    covered += expectedHeights[expectedIndex] ?? 0;
  }
  assertCondition(
    randomizedGeometry.pageAt(position) === randomizedPages[expectedIndex]?.id,
    "randomized inverse lookup diverged",
  );
}

process.stdout.write("page geometry regression suite passed\n");
