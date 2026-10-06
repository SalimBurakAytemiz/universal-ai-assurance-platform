import { isLocalTarget, toLocalUrl } from "./real_adapter.mjs";

const bs = String.fromCharCode(92);
const unc = bs + bs + "evil.com" + bs + "x"; // \\evil.com\x

for (const t of ["//evil.com/x", unc, "/evil.com/x", "C:/local/a.html"]) {
  const local = isLocalTarget(t);
  let res, host = "(n/a)";
  try { res = toLocalUrl(t); host = new URL(res).host; } catch (e) { res = "THROW " + e.message; }
  console.log(JSON.stringify(t), "| isLocalTarget=", local, "| toLocalUrl=", JSON.stringify(res), "| host=", JSON.stringify(host));
}
