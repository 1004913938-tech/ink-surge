// admin.html is bundled as a string by wrangler's default Text rule (**/*.html).
declare module "*.html" {
  const s: string;
  export default s;
}
