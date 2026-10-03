# Chalk · Macros module — build spec (contract for all agents)

Chalk is Nick Ahrens' single-file gym PWA (index.html, GitHub Pages, iPhone home-screen app, used by Nick and Katerina on their own phones). We are adding a full macro / meal / weight tracker ("Macros") inside Chalk. The person opens Chalk and flips between **Train** and **Macros** with one obvious control. Everything must feel like one app: same fonts (Barlow / Barlow Condensed), same tokens, same card/button/sheet styles (see `chalk-css.css` in the spec folder for every existing class).

Owner's answers (do not re-ask):
- Build straight into Chalk. Navigation between training and macros must be extremely clear.
- Users: Nick and Katerina only. Chalk already has a person picker (`S.profile` = `"nick"` | `"kat"`). Macros uses the same active person.
- Profile numbers (sex, age, height, weight, goal weight, activity, pace) are entered on first use. If more than 60 days pass since they were entered, ask again (skippable).
- Default macro split: **high protein**.
- Food data: no API keys required. Open Food Facts for barcodes and packaged search, a built-in generic foods list, and Claude to estimate anything missing (Claude runs via `claude.use("sample")` when opened inside claude.ai, or via an Anthropic API key the person pastes once in the You tab; key stays on the device).
- MyFitnessPal complaints to fix: ads (none), saved meals hard to find (dedicated Foods tab, meals grouped by Breakfast / Lunch / Dinner / Snacks, searchable, each with a name AND a description), bad barcode scanning (fast continuous scanner, manual code, photo-of-barcode fallback, label scan fallback), and a **Suggest a meal** button (built-in list of high-protein meals from King Soopers & Costco staples in Denver, plus Claude suggestions fitted to the remaining macros).
- Track resting heart rate too. Weight and RHR can be logged any time; every 2 weeks the app asks for both (skippable, "continue to app").

## Files (each owned by ONE builder agent)

| File | Owner | Purpose |
|---|---|---|
| `m-core.js` | core | `M` namespace: state, storage, sync, calc engine, food math, log/meals/foods/body CRUD, search ranking, check-ins, mode. No DOM. |
| `m-data.js` | data | `M.DB.generic` (generic foods) and `M.DB.suggest` (built-in meal suggestions). Pure data. |
| `m-food.js` | food | `M.food` + `M.ai`: Open Food Facts, barcode scanner, label OCR + parser, AI provider (sample / API key), photo + describe estimation, suggestions engine. |
| `m-ui.js` + `m.css` | ui | `M.ui`: shell (chrome, tabs, delegation), Diary view, Add-food flows (search, barcode, label, photo, describe, suggest), entry edit, Foods tab (saved meals + my foods + meal builder + manual food form). All macro CSS. |
| `m-trends.js` + `m-trends.css` | trends | Trends view (weight / RHR charts, weekly macro bars), You view (profile numbers + calculator + split + targets + units + AI key + person switch), check-in cards (first-day setup, 60-day refresh, 2-week body), Train-mode banner. Its own CSS file (classes prefixed `mt-`). |
| `index.html`, `sw.js`, `manifest.json` | integration | Mode bar, script/css tags, hooks into Chalk's `render()`, tabs listener, export/import, Train Today banner, cache bump. |

Load order in index.html (all BEFORE Chalk's big inline `<script>`, which boots with `applyTheme(); render();` at its end):
```html
<link rel="stylesheet" href="m.css">
<link rel="stylesheet" href="m-trends.css">
<script src="m-core.js"></script>
<script src="m-data.js"></script>
<script src="m-food.js"></script>
<script src="m-ui.js"></script>
<script src="m-trends.js"></script>
```
Every m-*.js file starts with `window.M = window.M || {};` and must never throw at load time. Chalk's globals (`S`, `render`, `openSheet`, `closeSheet`, `toast`, `esc`, `uid`, `PRESETS`, `save`, `dbOn`) are only read lazily inside functions (they exist by the time any handler runs). Guard with `typeof X !== "undefined"` where a function might run before Chalk boots.

Plain ES2020 browser JS, no build step, no modules, no TypeScript. Works on iOS Safari 16+. No `alert/confirm/prompt` — build confirmations into the UI.

## Chalk facts you must respect

- Layout: `.top` (title h1#title + .sub#subtitle) · `#scroll > .wrap#app` (the ONLY scrolling element) · `.cta#cta` (bottom action button area, `.on` shows it) · `nav.tabs#tabs` (bottom tabs, 4 buttons) · `#sheetBg/#sheet` bottom sheet · `#toast`.
- Helpers to reuse (globals): `openSheet(title, html)`, `closeSheet()`, `toast(msg)`, `esc(s)`, `uid()`, `render()`. Sheet close button is `<button class="icon" data-a="sheet-close">×</button>` (Chalk handles it).
- Chalk's click delegation is `document.addEventListener("click", e => e.target.closest("[data-a]") …)`. **Macro UI uses `data-m` attributes only** (never `data-a`, except reusing Chalk's `data-a="sheet-close"` and the person picker `data-a="pick-profile" data-v="nick|kat"`).
- Person: `S.profile` is `"nick"` / `"kat"` / `null`. Names: `PRESETS.nick.name = "Nick"`, `PRESETS.kat.name = "Katerina"`.
- Theme: `html[data-theme]` + tokens `--bg --sur --sur2 --ink --mut --line --acc --acc-ink --acc-soft --ok --ok-soft --warn --warn-soft --chip --shadow --mus` (blue). Always use tokens. Add new tokens for macro colors in `m.css` under the same three-block pattern (bare `:root`, `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])`, `:root[data-theme="dark"]`).
- Existing CSS classes you should reuse: `.card .hd .bd h3`, `.btn .btn.primary .btn.block .btn.ghost .btn.danger`, `.icon`, `.tag .tag.acc .tag.ok .tag.warn`, `.chip .chips`, `.seg > button.on`, `.srow .l .s`, `.toggle.on`, `.stepper.sm`, `h2.sec`, `.hint`, `.empty`, `.opt .opt.cur .opt .m`, `.opt-grp`, `input.mini`, `select.sel`, `textarea`, `.stats .stat`, `.mut .small .up .num .cond`.
- Chalk's `render()` is the single render entry point. Integration patches it so that when `M.mode()==="macros"` it calls `M.ui.render()` and returns. Macro code that needs a re-render calls `M.ui.rerender()` (defined in m-ui.js as `() => (typeof render==="function" ? render() : M.ui.render())`).

## Mode bar (integration + ui css)

A new full-width bar between `.top` and `#scroll`:
```html
<div class="modebar" id="modebar">
  <button data-m="mode" data-v="train"><svg …dumbbell…></svg>Train</button>
  <button data-m="mode" data-v="macros"><svg …fork/knife or plate…></svg>Macros</button>
</div>
```
`flex:none`, two equal halves, 44px tall, condensed uppercase 16px, active half filled with `--acc` and `--acc-ink`, inactive `--sur2`/`--mut`, 1px `--line` separator. `M.ui.chrome()` sets `.on` on the active half and swaps `#tabs` content: train mode restores Chalk's original tab buttons (integration stores the original innerHTML in `window.TRAIN_TABS` at boot); macros mode sets `M.ui.tabsHTML()`.

Macro tabs (4): `data-mtab="diary"` Diary · `data-mtab="foods"` Foods · `data-mtab="trends"` Trends · `data-mtab="you"` You. Same SVG icon style as Chalk (24px stroke icons). Integration patches Chalk's `#tabs` click listener: `if(b.dataset.mtab){ M.ui.tab=b.dataset.mtab; M.ui.render(); return; }`.

## State (m-core.js) — `M.MS`, localStorage key `chalk.macros.v1`

```js
MS = {
  v: 1, updatedAt: 0,
  ui: { mode: "train", person: null, date: null, tab: "diary" },   // mode: "train"|"macros"
  profiles: { nick: Profile, kat: Profile },    // created lazily by M.person(id)
  foods: { [id]: Food },      // custom / scanned / AI foods library (shared on this device)
  meals: { [id]: Meal },      // saved meals (recipes)
  days:  { ["nick|2026-09-28"]: Day },
  body:  { ["nick|2026-09-28"]: Body },
}
Profile = { id:"nick", name:"Nick", sex:"m"|"f"|null, age:null, heightIn:null, weightLb:null, goalWeightLb:null,
  activity:"sedentary"|"light"|"moderate"|"active"|"very", pace:0,      // pace in lb/week, negative = lose (allowed: -2,-1.5,-1,-0.5,0,0.5,1)
  units:"us"|"metric", split:"highprotein"|"balanced"|"lowcarb"|"keto"|"custom", custom:{p:30,c:40,f:30},
  targets:{cal:2000,p:150,c:200,f:65,fiber:28,water:80}, targetsManual:false,   // water in oz
  setupAt:null, snooze:{refresh60:0, body14:0}, lastBody:0, aiModel:"claude-sonnet-5-5" }
Food = { id, name, brand:"", barcode:"", source:"generic"|"custom"|"off"|"label"|"photo"|"ai",
  serving:{qty:1, unit:"cup", g:240|null},   // ONE serving as displayed; g = grams per serving when known
  per:{cal,p,c,f,fiber,sugar,sodium},         // per ONE serving. cal kcal; p c f fiber sugar grams; sodium mg. Missing → 0.
  per100g:{…}|null, alts:[{label:"1 oz", g:28}] , createdAt, updatedAt, uses:0, lastUsed:0, pid }
Entry = { id, slot:"Breakfast"|"Lunch"|"Dinner"|"Snacks", name, brand, servings:1, servingLabel:"1 cup (240 g)", g:240|null, per:{…per one serving…}, foodId?, mealId?, at }
Meal = { id, name, desc, slot:"Breakfast"|"Lunch"|"Dinner"|"Snacks"|"Any", items:[Entry-like without slot], servingsMade:1,
  per:{…} /* per ONE serving of the meal = sum(items)/servingsMade */, createdAt, updatedAt, uses:0, lastUsed:0, pid }
Day  = { id:"nick|2026-09-28", pid:"nick", date:"2026-09-28", entries:[Entry], water:0 /*oz*/, note:"", updatedAt }
Body = { id:"nick|2026-09-28", pid, date, w:null|number /*lb, stored in lb always*/, rhr:null|number /*bpm*/, at }
```
Units: store US internally (lb, in, oz). `profile.units==="metric"` only changes display/input (kg, cm, ml) via `M.units.*`.

The Anthropic API key is device-only: `localStorage["chalk.ai.key"]` (never inside MS, never synced, never exported).

### `M` API (m-core.js) — exact names
```js
M.KEY, M.MS, M.SLOTS = ["Breakfast","Lunch","Dinner","Snacks"], M.NUT = ["cal","p","c","f","fiber","sugar","sodium"]
M.uid(), M.esc(s), M.cp(obj)                         // reuse Chalk's uid/esc when present
M.today() -> "YYYY-MM-DD" (local time); M.addDays(key,n); M.fmtDay(key) -> "Today" | "Yesterday" | "Tomorrow" | "Mon, Sep 28"; M.daysBetween(a,b); M.tsToKey(ts)
M.defaultSlot(date=new Date()) -> "Breakfast" (<10:30) | "Lunch" (<14:30) | "Dinner" (<20:30) | "Snacks"
M.load(); M.save() (updatedAt, localStorage, debounced M.sync.push()); M.reset()
M.mode() -> "train"|"macros"; M.setMode(m)
M.pid() -> active person id: (typeof S!=="undefined" && S.profile) || MS.ui.person || null
M.person(id = M.pid()) -> Profile (creates default; name from PRESETS if available)
M.units = { lb2kg, kg2lb, in2cm, cm2in, oz2ml, ml2oz, fmtW(lb, units) -> "185 lb"|"83.9 kg", fmtH(in, units) -> `5'11"`|"180 cm", parseH(str, units) }
M.calc = {
  ACT: { sedentary:1.2, light:1.375, moderate:1.55, active:1.725, very:1.9 },
  ACT_LABEL: { sedentary:"Desk job, little exercise", light:"Light exercise 1–3 days/wk", moderate:"Moderate exercise 3–5 days/wk", active:"Hard training 6–7 days/wk", very:"Athlete / physical job" },
  PACE_LABEL: { "-2":"Lose 2 lb/wk", "-1.5":"Lose 1.5 lb/wk", "-1":"Lose 1 lb/wk", "-0.5":"Lose 0.5 lb/wk", "0":"Maintain", "0.5":"Gain 0.5 lb/wk", "1":"Gain 1 lb/wk" },
  SPLITS: { highprotein:{label:"High protein", desc:"1 g protein per lb of bodyweight, 25% fat, rest carbs"}, balanced:{label:"Balanced", desc:"30% protein · 40% carbs · 30% fat", p:30,c:40,f:30}, lowcarb:{label:"Low carb", desc:"40% protein · 20% carbs · 40% fat", p:40,c:20,f:40}, keto:{label:"Keto", desc:"25% protein · 5% carbs · 70% fat", p:25,c:5,f:70}, custom:{label:"Custom", desc:"Set your own percentages"} },
  bmr({sex,age,heightIn,weightLb}) -> kcal (Mifflin-St Jeor: 10*kg + 6.25*cm - 5*age + (m ? 5 : -161)),
  tdee(profile) -> bmr * ACT[activity],
  calories(profile) -> round(tdee + pace*500) but never below 1200 (f) / 1500 (m); returns {cal, floored:boolean},
  targets(profile) -> {cal,p,c,f,fiber,water}:
     highprotein: p = round(1.0 * weightLb) (if that exceeds 40% of cal, cap at 40%); f = round(0.25*cal/9); c = round((cal - p*4 - f*9)/4) (min 50)
     pct splits: p = round(cal*P/100/4), c = round(cal*C/100/4), f = round(cal*F/100/9)
     fiber = round(cal/1000*14); water = round(weightLb*0.5/8)*8 (oz, min 64)
  complete(profile) -> boolean (sex, age, heightIn, weightLb all set)
}
M.foodMath = { scale(per, servings) -> per*servings (all NUT keys, rounded 1dp), sum(list of {per,servings}) -> totals, fromPer100(per100g, grams) -> per, blank() -> zeros, pct(per) -> {p,c,f} % of calories }
M.foods = { add(food) -> food (fills id/createdAt), update(id, patch), remove(id), get(id), list() -> [] sorted by lastUsed desc, findByBarcode(code), touch(id) }
M.meals = { add(meal) -> meal (computes per), update(id, patch) (recomputes per), remove(id), get(id), list(slot?) -> [] (slot filter incl. "Any"), computePer(meal), touch(id) }
M.day(dateKey, pid?) -> Day (creates in MS.days, does NOT save)
M.log = { add(dateKey, entry) -> entry (fills id/at; touches food/meal uses), update(dateKey, entryId, patch), remove(dateKey, entryId), move(dateKey, entryId, slot),
          addMeal(dateKey, mealId, servings, slot) -> [entries] (ONE entry per meal, name = meal name, mealId set, per = meal.per, servingLabel = "1 serving"),
          copySlot(fromKey, toKey, slot), clearSlot(dateKey, slot), totals(dateKey) -> per-like totals, slotTotals(dateKey, slot), slotEntries(dateKey, slot),
          setWater(dateKey, oz), loggedDays(pid) -> [dateKeys] }
M.body = { add({date, w, rhr}) (merges into existing key; sets profile.lastBody=Date.now(); updates profile.weightLb when w given), remove(date), list(pid) -> sorted asc by date,
           latest(pid, field) -> {date,value}|null, series(pid, field, days) -> [{date, v}], avg7(series) -> [{date, v}], ratePerWeek(pid) -> lb/wk from 7-day averages over last 28 days |null }
M.recents(pid, n=20) -> [{name, brand, servingLabel, g, per, foodId, mealId, lastUsed, count}] deduped by name from last 60 days of entries, most recent first
M.search(q, {pid, slot, limit=40}) -> [Result] where Result = { kind:"recent"|"meal"|"food"|"generic", id, name, brand, sub /* serving label */, per, serving, alts, ref /* the source object */ }
   ranking: q empty → recents (10) then slot-matching meals then other meals; q set → prefix/word matches score higher; meals matching slot boosted; generic DB (M.DB.generic) included; case-insensitive; tokens all must match somewhere in name+brand.
M.checkins = { due(pid) -> null | "setup" | "refresh60" | "body14",   // setup: no setupAt; refresh60: setupAt older than 60 days and snooze.refresh60 < now; body14: lastBody older than 14 days and snooze.body14 < now
               snooze(pid, kind, days), done(pid, kind) }
M.streak(pid) -> consecutive days (ending today or yesterday) with ≥1 entry
M.weekSummary(pid, weeksBack=0) -> { days:7, logged:n, avgCal, avgP, avgC, avgF, target:{…} }
M.export() -> MS (plain object); M.import(obj) (validates v, merges, saves)
M.sync = { init() async (inside claude.ai only: db doc "macros/state" for profiles+foods+meals+ui, collections "mdays" and "mbody"; merge like Chalk: newer updatedAt wins, union collections), push() debounced 800ms, pushDay(id), pushBody(id) }  // must be a no-op outside claude.ai
```
All mutators call `M.save()`.

## Data (m-data.js)
`M.DB.generic` — at least 220 foods, each a Food with `id: "g_<slug>"`, `source:"generic"`, accurate USDA-style per-serving values, `per100g` where sensible, `alts` with gram weights. Cover: proteins (chicken breast/thigh raw & cooked, ground beef 80/85/90/93, sirloin, ribeye, pork chop, pork tenderloin, bacon, turkey breast, ground turkey 93, salmon, tilapia, cod, tuna canned in water, shrimp, eggs, egg whites, Greek yogurt plain 0% and 2% and 5%, cottage cheese 2% and 4%, whey protein scoop, casein, tofu, tempeh, edamame, lentils, black beans, chickpeas, deli turkey, deli ham, rotisserie chicken (Kirkland), Kirkland protein bar, Fairlife 2% milk, Fairlife Core Power 26g/42g, Premier Protein shake, Chobani, Fage, Oikos Triple Zero, Kodiak pancake mix, Dave's Killer Bread 21 grains, Kirkland organic peanut butter, Kirkland almonds, Kirkland eggs, Kirkland chicken breast, Kirkland salmon, Costco bakery items, King Soopers/Kroger store-brand basics), carbs (white rice cooked, brown rice cooked, jasmine, quinoa, oats dry/cooked, potato, sweet potato, bread slices, bagel, tortilla flour/corn, pasta cooked, couscous, rice cakes, cereals: Cheerios, granola), fats (olive oil, avocado oil, butter, avocado, almonds, walnuts, cashews, peanuts, peanut butter, almond butter, cheese cheddar/mozzarella/feta/parmesan/string cheese, cream cheese, mayo, ranch, sour cream), fruit (banana, apple, orange, strawberries, blueberries, grapes, watermelon, pineapple, mango, dates), vegetables (broccoli, spinach, kale, lettuce, tomato, cucumber, bell pepper, carrots, onion, mushrooms, green beans, asparagus, corn, peas, zucchini, cauliflower), dairy/drinks (milk whole/2%/skim, almond milk, oat milk, coffee, latte, orange juice, beer, wine, whiskey shot, seltzer), condiments/sauces (ketchup, mustard, hot sauce, soy sauce, BBQ sauce, honey, maple syrup, jam, salsa, guacamole, hummus), common meals (burrito, cheeseburger, pizza slice, chicken sandwich, Chipotle bowl components, sushi roll, ramen, pho, tacos, Caesar salad, protein pancakes), snacks (protein chips, tortilla chips, popcorn, pretzels, dark chocolate, ice cream, cookies, trail mix, beef jerky).
`M.DB.suggest` — at least 40 built-in meal suggestions, ~10 per slot (`slot` field), each `{ id, name, desc (one plain sentence a middle-schooler gets), slot, store:"King Soopers"|"Costco"|"Either", prepMin, items:[{name, servingLabel, g, per}], per (sum of items), tags:["high-protein","quick","no-cook",…] }` — high-protein, realistic, built from items sold at King Soopers / Costco (Kirkland rotisserie chicken, Fage, Kirkland ground beef, Fairlife, Dave's Killer Bread, Kodiak, Costco salmon, Just Bare chicken, etc.). Macros computed from items (sanity: per.cal ≈ 4p+4c+9f ± 15%).

## Food + AI (m-food.js)
```js
M.ai = { mode() -> "sample"|"key"|null, ready() -> bool, getKey(), setKey(k), model() ,
         json(prompt, {images?:Blob[], tier?:"quick"|"default"}) -> Promise<object> }   // returns parsed JSON; asks for JSON only; strips ``` fences; throws {code,message}
   sample path: const s = await claude.use("sample"); limits = await s.limits(); images only if limits.images; s.json(prompt,{images,modelTier}) 
   key path: fetch POST https://api.anthropic.com/v1/messages, headers x-api-key, anthropic-version "2023-06-01", anthropic-dangerous-direct-browser-access "true", content-type application/json;
             body {model, max_tokens:1500, messages:[{role:"user", content:[...images as {type:"image", source:{type:"base64", media_type:"image/jpeg", data}}, {type:"text", text: prompt}]}]};
             model default profile.aiModel || "claude-sonnet-5-5"; on 404/not_found retry once with "claude-haiku-4-5-20251001". Downscale images with canvas to max 1280px JPEG q0.85 before base64.
M.img = { downscale(file, maxPx=1280, quality=0.85) -> Promise<Blob(jpeg)>, toBase64(blob) -> Promise<string(no prefix)> }
M.food = {
  barcode(code) -> Promise<Food|null>,    // OFF v2: https://world.openfoodfacts.org/api/v2/product/{code}.json?fields=code,product_name,brands,serving_size,serving_quantity,quantity,nutriments ; try code, then 12-digit→"0"+code, 13-digit starting "0"→stripped. source:"off". 8s timeout.
  searchOFF(q) -> Promise<Food[]>,        // https://world.openfoodfacts.org/cgi/search.pl?search_terms=..&search_simple=1&action=process&json=1&page_size=15&fields=... (bias US: &tagtype_0=countries&tag_contains_0=contains&tag_0=united-states). Skip items with no calories.
  fromOFF(product) -> Food|null (pure, testable): per from nutriments *_serving when serving_quantity>0 else per100g scaled to serving g (serving_quantity || 100); per100g always; sodium mg = sodium_100g*1000 (OFF stores g); salt fallback sodium = salt/2.5; energy-kcal preferred, else energy_100g/4.184.
  scanner: { start(containerEl, onCode) -> Promise (native BarcodeDetector when it reads EAN-13/EAN-8/UPC-A/UPC-E, else barcode-detector@3.2.2 IIFE + zxing-wasm@3.1.3 from cdn.jsdelivr.net in a Web Worker; 1920x1080 environment camera, center-band decode ~12 fps, check digit + same code on 2 frames, 3 s dedupe, vibrate + beep, torch / 2x zoom when supported), stop(), fromImage(file), torch(on), hasTorch(), zoom(x), hasZoom(), preload() },
  label: { fromImage(file) -> Promise<{food:Partial<Food>, method:"ai"|"ocr", rawText}> (AI when M.ai.ready(); else OCR via lazy https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js, preprocess: downscale to 1600px, grayscale + contrast on canvas, then parse),
           parse(text) -> Partial<Food> (pure, testable; US Nutrition Facts: Calories, Total Fat, Sodium, Total Carbohydrate/Carb, Dietary Fiber, Total Sugars/Sugars, Protein, Serving size "2/3 cup (55g)" etc.; tolerate OCR noise: O→0, l/I→1, missing units; sodium mg) },
  photo: { estimate(file, {slot}) -> Promise<{items:[{name, servingLabel, g, per}], note}> }  // AI only; reject {code:"no_ai"} otherwise
  describe(text, {slot}) -> Promise<{items:[…]}>   // AI when ready; fallback: split on commas/"and", parse leading quantity, match M.DB.generic + M.foods by words, scale by quantity
  estimateByName(name) -> Promise<Food|null>   // AI; source "ai"
  suggest({pid, slot, remaining, exclude}) -> Promise<Suggestion[]>  // order: source "mine" (their saved meals that fit), "often" (combos they log together in that slot, last 60 days), "idea" (M.DB.suggest, brand-free, built from their staples), "claude" (3 ideas when a key is set; list.aiError holds a plain error). Never throws.
}
```
Prompts must demand JSON only with the exact shapes above (sodium in mg; servingLabel like "1 cup (240 g)"). All network calls have timeouts and reject with `{code, message}`; the UI shows plain-English messages.

## UI (m-ui.js + m.css) and Trends/You (m-trends.js)
```js
M.ui = { tab:"diary", date:M.today(), render(), rerender(), chrome(), tabsHTML(), bind() /* idempotent delegation on document for click/input/change: element with data-m → M.ui.actions[name](el, e) / M.ui.inputs[name](el, e) / M.ui.changes[name](el,e) */,
         actions:{}, inputs:{}, changes:{}, views:{ diary(), foods(), trends() /*m-trends*/, you() /*m-trends*/ },
         sheet(title, html) (= openSheet), close() (= closeSheet), toast(m),
         bannerHTML() /* m-trends: HTML for due check-in card, "" if none — used in Diary and in Chalk's Train Today */,
         setupCardHTML(), calculatorHTML(profile) /* m-trends */ , ring(cal, target) -> svg string, bars(totals, targets) -> html }
```
`M.ui.render()`: sets `#title` ("Macros") and `#subtitle` (person name + date for diary), `#app.innerHTML = view`, `#cta` (Diary: `<button class="btn primary block" data-m="add" data-slot="">+ Log food</button>`, others hidden), calls `chrome()`, resets scroll on tab change, and if `!M.pid()` renders the person picker (two `.card`s with `data-a="pick-profile" data-v="nick|kat"` buttons — Chalk's handler will set S.profile and re-render).

### Diary (tab "diary") — MyFitnessPal layout, cleaner
1. Check-in card from `M.ui.bannerHTML()` when due (setup replaces the whole diary until done).
2. Day header card: `‹` / date label (`M.fmtDay`) / `›` (`data-m="day-prev"`, `data-m="day-today"`, `data-m="day-next"`), calorie ring (SVG, 120px) with remaining kcal big in the center and "left" under it (goes `--warn` when over), right side: eaten / target. Below: 3 macro bars (Protein / Carbs / Fat) with `g / g` and fill; protein bar uses `--mus` blue; carbs `--acc` gold; fat a new token `--fat` (muted orange). "More" toggle (`data-m="more"`) reveals fiber, sugar, sodium chips and water row (`data-m="water"` +8 oz / −8 oz, glasses).
3. Four slot cards (Breakfast / Lunch / Dinner / Snacks): header has slot name + subtotal kcal + `…` menu (`data-m="slot-menu"`: Copy yesterday's {slot}, Save {slot} as a meal, Clear {slot}); entries as `.ex-row`-style rows: name (bold), sub line "1.5 × 1 cup (240 g) · P 12 · C 30 · F 4", right: kcal; tap row → entry sheet (`data-m="entry"`); "+ Add" button at the bottom of each card (`data-m="add" data-slot="Lunch"`).
4. Bottom summary: streak chip ("🔥 5-day streak") and "Suggest a meal" button (`data-m="suggest"`).

Entry sheet: name/brand, servings stepper (0.25 steps, direct input), serving-unit select (the food's serving + alts + "g"), live totals, slot select, buttons Save / Move / Delete / "Save as food" for AI/photo items.

### Add flow (sheet, reused for Diary add and Meal builder "pick" mode via `M.ui.openAdd({slot, date, onPick?})`)
Top: slot pill selector (defaults `M.defaultSlot()` or given); search input `data-m="search"` (input handler, debounce 150ms local, 500ms OFF); action row of 5 small buttons: Scan barcode · Scan label · Photo · Describe · Suggest. Below: segmented `Recent | Meals | Foods`. Results list rows (`data-m="pick" data-kind data-id`) with name, brand · serving, kcal; Meals tab groups by slot with the current slot first and shows the meal description under the name; Foods shows local matches instantly then appends "From Open Food Facts" results when they arrive (no results → "Nothing found. Scan the label or describe it." with buttons). Tapping a result opens the detail sheet (servings stepper, unit select, slot, "Add to Lunch"). When `onPick` is given, the detail sheet's button says "Add to meal" and calls `onPick(entry)` instead of logging.

Barcode sheet: `<div id="m-scan">` camera area (`M.food.scanner.start`), status line, manual input + Look up, "Photo of barcode" file input, Cancel stops the scanner. On code: look up → detail sheet (new foods are added to `M.foods` with source "off"); not found → card with "Scan the label" and "Type it in" buttons. Always stop the scanner when the sheet closes (hook `M.ui.close`).

Label sheet: file input (`accept="image/*" capture="environment"`), progress text ("Reading label…"), then an editable form (name, brand, serving qty, unit, grams, cal, protein, carbs, fat, fiber, sugar, sodium) prefilled from `M.food.label.fromImage`, buttons "Save & add to {slot}" and "Save to my foods". Method badge ("Read by Claude" / "Read by OCR — check the numbers").

Photo sheet: file input → "Estimating…" → list of items with servings steppers and a note → "Add all to {slot}"; without AI show a card explaining "Photo logging needs Claude. Add your Anthropic key in You → AI" with a button `data-m="tab" data-v="you"`.

Describe sheet: textarea placeholder "2 eggs, 2 slices sourdough, 1 tbsp butter" → items list → Add all.

Suggest sheet: shows remaining kcal / P / C / F for the day and the slot; list of suggestions (name, desc, store tag, prep min, macros per serving); buttons per suggestion "Log it" (logs one entry per item) and "Save as meal". AI suggestions marked with a tag "Claude". A "More ideas" button re-runs.

### Foods (tab "foods")
Segmented: **Saved meals** | **My foods**. Saved meals: search box; groups by slot in order Breakfast, Lunch, Dinner, Snacks, Any; each row: name (bold), description (muted, 2 lines max), macros line "420 kcal · P 38 · C 40 · F 12 per serving", tap → meal sheet (Log to today {slot picker}, Edit, Duplicate, Delete). "+ New meal" opens the meal builder sheet: name, description, slot, servings made, items list with "+ Add item" (uses the add flow in pick mode), live per-serving totals, Save. My foods: search; rows with name/brand/serving/kcal; tap → edit form (same as label form) with Delete; "+ New food" opens the blank form.

### Trends (tab "trends", m-trends.js)
Cards: (1) Weight — current (latest), change vs 7-day average, rate/wk, goal and distance to goal; range chips 30 / 90 / All; SVG line chart with daily points, 7-day average line, dashed goal line, y axis ticks, last point emphasized; empty state text. (2) Resting heart rate — same style chart, average of last 7. (3) This week — days logged, avg kcal vs target, avg protein vs target, small bar per day (7 bars, target line). (4) Last 8 weeks — bars of avg kcal with target line. Button "Log weight / heart rate" opens a sheet (weight in the person's units, RHR, date defaulting today) → `M.body.add`. Load the `dataviz` skill before writing chart code; colors from tokens; `tabular-nums`.

### You (tab "you", m-trends.js)
Card "Your numbers": sex (seg), age, height (ft/in or cm), current weight (also creates a body entry when changed), goal weight, activity (select with labels), pace (select), units (seg). Card "Macro targets": split presets as `.opt` rows with descriptions, custom percentages when custom, computed targets (cal / P / C / F / fiber / water) with an "Edit targets manually" toggle (targetsManual → editable numbers). Recalculate happens automatically from the numbers unless targetsManual. Card "Check-ins": last setup date, "Numbers reviewed" button (resets setupAt), 2-week body check status. Card "AI (Claude)": status line (Inside claude.ai → "Claude ready" / key set → "Key saved on this phone" / none → explanation), password-style input for the key, Save / Remove, model select (claude-sonnet-5-5 default, claude-haiku-4-5-20251001 cheaper), "Test" button that calls `M.ai.json("Reply with {\"ok\":true}")`. Card "Person": "Now: Nick — Switch" (`data-a="switch-profile"`). Card "Data": note that backup lives in Train → Settings and now includes Macros.

### Check-ins (m-trends.js)
- `M.checkins.due(pid)==="setup"` → the Diary shows only the setup card: friendly first-day form ("Let's set your targets") with the same fields as You + split choice (high protein preselected) + computed preview; Save → `setupAt=Date.now()`, targets computed, toast.
- `"refresh60"` → card at the top of Diary: "It's been 60+ days since you set your numbers. Still accurate?" buttons: "Update" (opens You tab) / "They're the same" (setupAt=now) / "Skip for now" (snooze 7 days).
- `"body14"` → card: "Quick check-in" with weight + RHR inputs (both optional) and buttons "Save" / "Skip" (snooze 14 days). Also rendered in Train Today via `M.ui.bannerHTML()`.

### CSS (m.css)
Tokens added: `--fat`, `--carb`(= --acc), `--pro`(= --mus), `--ring-bg`. Classes prefixed `m-`. Rows have 44px+ tap targets. No horizontal scroll at 390px. Tabular numbers everywhere numbers stack. Keep the Chalk look: cards 14px radius, condensed uppercase primary buttons.

## Integration (index.html, sw.js, manifest.json)
1. Add the `<link>` + 5 `<script>` tags before Chalk's inline script.
2. Insert the mode bar after `.top`.
3. At the very top of Chalk's `render()`: `if(window.M){ M.ui.chrome(); if(M.mode()==="macros"){ M.ui.render(); return; } }`.
4. Patch the `#tabs` click listener for `data-mtab`.
5. `viewToday()`: prepend `(window.M&&M.ui.bannerHTML?M.ui.bannerHTML():"")`.
6. Export/import: include macros. Export: `JSON.stringify({...S, __macros: M.export()})`; import: `if(parsed.__macros) M.import(parsed.__macros); delete parsed.__macros;`.
7. In Chalk's `case "switch-profile"` nothing changes; in `case "pick-profile"` nothing changes (M reads S.profile lazily). Wipe: also `M.reset()`.
8. Chalk's boot line `applyTheme(); render();` → before it: `window.TRAIN_TABS = document.getElementById("tabs").innerHTML;` and `M.ui.bind(); M.sync.init();`.
9. `sw.js`: CACHE `chalk-v11`, CORE adds `m.css, m-trends.css, m-core.js, m-data.js, m-food.js, m-ui.js, m-trends.js`. Cross-origin requests (jsdelivr, openfoodfacts, api.anthropic.com) must NOT be intercepted (the existing fetch handler already returns early for other origins — verify).
10. `manifest.json` description: "Gym log and macro tracker."

## Testing rules for every builder and buddy
- `node --check <file>` must pass.
- Pure functions (calc, foodMath, search, label.parse, fromOFF, suggestion scoring, meals.computePer, body.avg7/ratePerWeek) get a `tests/<file>.test.js` runnable with `node tests/<file>.test.js` (plain asserts, stub `window`/`localStorage` with a tiny shim at the top). Keep tests in `tests/` (they are committed; they don't ship in sw cache).
- No placeholders, no TODOs, no "coming soon". Everything described here works.

## Sharing between the two people (v20) — `M.share` (m-core.js)
Nick and Katerina can send each other a logged meal (a whole slot or one entry), a saved meal, or an activity (walk / hike / golf). A share is a meal-shaped record in `M.MS.meals` with a `share` field (`{kind:"log"|"meal"|"activity", from, to, at, date, slot?, servingsMade?, batch?, act?, note?}`) and `pid = to`, so it travels on the household sync (kind `meal`) like any saved meal and shows up in the other person's inbox on their phone, or at once when they pick themselves on the same phone. `M.meals.list()` never returns a share. API: `M.share.send(o)`, `inbox(pid, kind?)`, `outbox(pid)`, `acceptLog(id, date?, slot?)` (copies the items into the receiver's own day), `acceptMeal(id)` (their own copy in Saved meals), `acceptActivity(id)` (returns the payload; Train writes it to `S.acts`), `dismiss(id)`, `cancel(id)`. Accepting or dismissing deletes the record (the deletion syncs). UI: Diary ⋯ slot menu "Send Breakfast to …", the entry sheet and the meal sheet carry "Send to …"; the Diary shows inbox cards (`M.ui.shareCardsHTML`) and a waiting line with "Take back"; Train → Today shows a one-line nudge (`M.ui.shareNoteHTML`) and the activity inbox. Sync must be on for phone-to-phone delivery; the send toast says so when it is off.

## Activities + facts (v20, index.html)
`S.acts` (created on first use, never by boot): `{id, act:"walk"|"hike"|"golf", start, min, mi, elev, holes, cart, cal, w, note, from?, fact?}`. Calories: MET × 3.5 × kg ÷ 200 × minutes, body weight from the Macros profile (`M.person(S.profile).weightLb`, 185 lb default). Walking MET by pace (Compendium table), hiking by the ACSM grade formula × 1.25 trail factor (4–9 MET), golf 5.3 walking with a push cart / 3.5 riding (≈0.28 mi a hole walked). History lists activities with workouts. After any workout or activity a praise line + one real-world fact (`pickFact`) is shown; `S.factSeen` keeps the last 40 fact ids so they don't repeat.
