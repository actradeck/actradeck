// pnpm install hooks (TDA-2 / decision 019f1b97).
//
// `@electric-sql/pglite-socket@0.2.6` は 7 つの PGlite 拡張 (pgvector/age/pg_hashids/pg_textsearch/
// pg_ivm/pg_uuidv7/pgtap) を **required peerDependencies** として宣言するが、dist で一切 import
// しない dead peer (grep 確認済・note 019f1b8a)。pnpm 既定の auto-install-peers=true がこれらを
// backend の prod 依存ツリーへ不要に取り込み install footprint / supply-chain surface を膨張させる
// (製品テーゼ=最小 install・decision 019e94d5 の lean backend deps とも衝突)。
//
// readPackage hook で pglite-socket の phantom peer を剥がし auto-install を抑止する。実際に必要な
// peer である `@electric-sql/pglite` (socket が db インスタンスを受ける本体) は残す。socket の
// dist はこれら拡張を import しないため剥がしても機能に影響しない。
//
// ⚠ TDA-N1: この dead 判定は pglite-socket@0.2.6 に紐づく (note 019f1b8a)。**バージョンを上げたら
// 上流が実際にこれら拡張を import しないか再検証**する (import する版で剥がすと real peer を silent
// strip し install/実行が壊れる)。name gate は exact match ゆえ他パッケージ・lookalike には非作用。
const PGLITE_SOCKET_PHANTOM_PEERS = [
  "@electric-sql/pglite-pgvector",
  "@electric-sql/pglite-age",
  "@electric-sql/pglite-pg_hashids",
  "@electric-sql/pglite-pg_textsearch",
  "@electric-sql/pglite-pg_ivm",
  "@electric-sql/pglite-pg_uuidv7",
  "@electric-sql/pglite-pgtap",
];

function readPackage(pkg) {
  if (pkg.name === "@electric-sql/pglite-socket" && pkg.peerDependencies) {
    for (const dep of PGLITE_SOCKET_PHANTOM_PEERS) {
      delete pkg.peerDependencies[dep];
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
