// The packed cache flag from binding-row.ts: a sunlight slot + 1, plus 256 once gradients bake.
fn sunlightSlot(flags: f32) -> i32 {
  return i32(u32(round(flags)) % 256u) - 1;
}
fn gradientsBaked(flags: f32) -> bool {
  return u32(round(flags)) / 256u != 0u;
}
