import jsyaml from "js-yaml";

/**
 * js-yaml, with the one thing it cannot read taught to it.
 *
 * `!!merge <<: *anchor` is how large hand-written compose files spell a merge key
 * (`x-common: &common` + `<<:` is the standard idiom, and several official
 * templates tag it explicitly). js-yaml 4 rejects the tagged form with
 * "bad indentation of a mapping entry", which sent people hunting a syntax error
 * that is not there - and left the stack unrewritten and unroutable.
 */
const MERGE_TAG_RE = /!!merge[ \t]+(?=<<[ \t]*:)/g;

export function load(src: string, opts?: jsyaml.LoadOptions): unknown {
  return jsyaml.load(
    typeof src === "string" ? src.replace(MERGE_TAG_RE, "") : src,
    opts,
  );
}

export const dump = jsyaml.dump;

const yaml = { load, dump };
export default yaml;
