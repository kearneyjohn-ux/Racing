// JB Refund Watch – iPhone Lock Screen widget for the Scriptable app.
// Shows JB Hi-Fi's live price for the Sony 85" BRAVIA 9 II vs the $6,800 paid.

const PRODUCT = "https://www.jbhifi.com.au/products/sony-85-bravia-9-ii-true-rgb-mini-led-ai-4k-google-tv-2026.js"
const PAGE = "https://claude.ai/artifact/7hupwKKWp4xRUmadVFKW6a"
const PAID = 6800
const WINDOW_ENDS = new Date("2026-12-07T23:59:00+11:00")

let price = null, inStock = null
try {
  const req = new Request(PRODUCT)
  req.headers = { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" }
  const data = await req.loadJSON()
  price = data.price / 100          // JB returns cents, e.g. 746100 = $7,461
  inStock = data.available
} catch (e) {
  price = null
}

const fmt = n => "$" + Math.round(n).toLocaleString("en-AU")
const daysLeft = Math.max(0, Math.ceil((WINDOW_ENDS - new Date()) / 86400000))
const refund = price != null ? Math.max(0, PAID - price) : 0
const family = config.widgetFamily || "accessoryRectangular"

const w = new ListWidget()
w.url = PAGE
w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000) // ask iOS to refresh in ~30 min

if (family === "accessoryInline") {
  w.addText(price == null ? "JB price unavailable"
    : refund > 0 ? `JB ${fmt(price)} · claim ${fmt(refund)}`
    : `JB ${fmt(price)} · ${daysLeft}d left`)

} else if (family === "accessoryCircular") {
  w.addAccessoryWidgetBackground = true
  const top = w.addText(refund > 0 ? "CLAIM" : "JB")
  top.font = Font.boldSystemFont(10); top.centerAlignText()
  const mid = w.addText(price == null ? "?" : refund > 0 ? fmt(refund) : `${daysLeft}d`)
  mid.font = Font.boldRoundedSystemFont(14); mid.centerAlignText(); mid.minimumScaleFactor = 0.6

} else {
  // accessoryRectangular (Lock Screen) and Home Screen sizes
  const t = w.addText("JB · Sony 85\" BRAVIA 9 II")
  t.font = Font.semiboldSystemFont(11); t.textOpacity = 0.8
  const p = w.addText(price == null ? "No data" : fmt(price))
  p.font = Font.boldRoundedSystemFont(22); p.minimumScaleFactor = 0.7
  const s = w.addText(price == null ? "Couldn't reach JB"
    : refund > 0 ? `Claim ${fmt(refund)} back!`
    : `Paid ${fmt(PAID)} · ${daysLeft}d left`)
  s.font = Font.systemFont(11)
  if (!family.startsWith("accessory")) {
    w.backgroundColor = refund > 0 ? new Color("#11784a") : new Color("#f5d10a")
    ;[t, p, s].forEach(x => x.textColor = refund > 0 ? Color.white() : new Color("#1a1700"))
  }
}

Script.setWidget(w)
if (config.runsInApp) await w.presentAccessoryRectangular()
Script.complete()
