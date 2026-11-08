// Text hygiene shared by everything that stores or prints text the athlete or the model wrote. No imports: any module may take it
// (plan-gen.ts imports proposals.ts, so the helper cannot live in plan-gen.ts).

/**
 * Characters that hide text, as ONE regex of escapes (the `u` flag is what makes \p{...} and \u{...} work; never paste the characters themselves):
 *  - every Unicode Default_Ignorable_Code_Point: soft hyphen \u00ad, combining grapheme joiner \u034f, Arabic letter mark \u061c, Hangul fillers
 *    \u115f \u1160 \u3164 \uffa0, Mongolian selectors \u180b-\u180f, zero-width and direction marks \u200b-\u200f, bidi overrides \u202a-\u202e,
 *    word joiner / invisible operators / the deprecated format controls \u2060-\u206f (bidi isolates \u2066-\u2069 are in there), variation selectors
 *    \ufe00-\ufe0f and \u{e0100}-\u{e01ef}, BOM \ufeff, the Unicode "tag" block \u{e0000}-\u{e007f} (invisible ASCII smuggling);
 *  - C0/C1 controls other than whitespace (\u0009-\u000d and \u0085 are handled as whitespace by oneLine);
 *  - the interlinear annotation marks \ufff9-\ufffb, which are not default-ignorable but hide text the same way.
 * Everything the athlete or the model writes goes through oneLine below.
 * Side effect, accepted: a ZWJ emoji sequence falls apart into its parts and an emoji loses its \ufe0f; CJK text and plain emoji are untouched.
 */
const HIDDEN = /[\p{Default_Ignorable_Code_Point}\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f\ufff9-\ufffb]/gu;
/** One line of plain text from anything the athlete or the model wrote: no hiding characters, every kind of line break and run of whitespace one space. */
export function oneLine(v: unknown): string {
  return typeof v === "string" ? v.replace(HIDDEN, "").replace(/[\s\u0085]+/g, " ").trim() : "";
}
