#!/usr/bin/env node
// @ts-check
"use strict";

const MAX_ALLOWED_PROPERTY_GROUPS = 0;
const MIN_COMPLEX_CLOSURE = 300;
const MIN_COMPLEX_OBJECT = 1;
const MIN_ALLOWED_NAME_LENGTH = 3;
const MIN_LONG_STRING = 20;
const MIN_STRING_LENGTH_TO_COMPUTE_GAIN = 2;
const MIN_EXPECTED_STRING_GAIN = 11;

// @ts-ignore
const TEST = typeof require === "function" && require.main === module;

const terser = require("terser");
/**
 * @typedef { import("terser").MinifyOptions } MinifyOptions
 * @typedef { import("terser").MinifyOutput } MinifyOutput
 * @typedef { import("terser").AST_Scope } AST_Scope
 * @typedef { Map<string, { references: object[]; mangled_name: string | null }> } VariableMap
 * @typedef { {
 *   vars?: { props?: { [oldName: string]: string } };
 *   props?: { props?: { [oldName: string]: string } };
 * } } NameCache
 */

/**
 * @param { string | import("terser").AST_Node } text
 * @param { MinifyOptions } options
 * @returns { {
 *   namesToMangle: string[][]
 *   namesCount: ReadonlyMap<string, number>
 * } }
 */
function collectWords(text, options) {
  /** @type { Map<string, number> } */
  const map = new Map();
  /** @type { string[][] } */
  let namesToMangle = [];
  const _props0 = options.mangle && typeof options.mangle === "object" ? options.mangle.properties : null,
  props0 = _props0 && typeof _props0 === "object" ? _props0 : null;
  /** @type { RegExp } */
  // @ts-ignore
  const propRe = props0 && props0.regex || /^_|_$/;
  const reservedProps = new Set(props0 && props0.reserved || [ "__proto__", "$_", "_" ]);
  terser.minify(text, { ...options,
    sourceMap: false, mangle: null, nameCache: null,
    // @ts-ignore
    output: { ast: true, code: false  }
  }).ast.walk(new terser.TreeWalker((node) => {
    switch (node.TYPE) {
    case "Function": case "Lambda":
      /** @type { AST_Scope } */
      // @ts-ignore
      const closure = node;
      /** @type { VariableMap } */
      // @ts-ignore
      const variables = closure.variables;
      if (variables.size < MIN_COMPLEX_CLOSURE && !(closure.name && closure.name.name === "VC")) { break; }
      const names = [];
      for (const [key, node] of closure.variables) {
        const ref_count = node.references.length;
        if (ref_count === 0) { continue; }
        const id = ":" + key + ":" + namesToMangle.length;
        names.push(id);
        map.set(id, (map.get(id) || 0) + ref_count);
      }
      if (names.length > 0) {
        namesToMangle.push(names)
      }
      break;
    case "Object":
      /** @type { import("terser").AST_Object } */
      // @ts-ignore
      const obj = node;
      if (obj.properties.length < MIN_COMPLEX_OBJECT) { break; }
      const list = obj.properties.map(i => {
        const prop = i.key;
        return typeof prop === "string" ? prop : "";
      }).filter(i => !!i);
      if (list.length === 0) { break; }
      let subCounter = 0;
      list.forEach(prop => {
        if (propRe.test(prop) && !reservedProps.has(prop)) {
          subCounter++;
          map.set(prop, (map.get(prop) || 0) + 1);
        }
      });
      if (subCounter > 0) {
        namesToMangle.push(list);
      }
      break;
    case "Dot":
      /** @type { import("terser").AST_Dot } */
      // @ts-ignore
      const dot = node;
      /** @type { string } */
      // @ts-ignore
      const prop = dot.property;
      if (propRe.test(prop) && !reservedProps.has(prop)) {
        map.set(prop, (map.get(prop) || 0) + 1);
      }
      break;
    // no default
    }
    return false;
  }));
  namesToMangle.forEach(arr => arr.sort((i, j) => {
    return (map.get(j) || 0) - (map.get(i) || 0) || (i < j ? -1 : 1);
  }));
  let ids = namesToMangle.map(i => i.join());
  for (let i = ids.length; 1 <= --i; ) {
    let j = ids.indexOf(ids[i]);
    if (j < i) {
      namesToMangle.splice(i, 1);
    }
  }
  return {namesToMangle, namesCount: map}
}

/**
 * @param { string | import("terser").AST_Node } text
 * @returns { {
  *   stringsTooLong: string[]
  *   stringGains: Map<string, {count: number; gain: number}>
  * } }
  */
function collectString(text) {
  /** @type { string[] } */
  const stringsTooLong = []
  /** @type { Map<string, number> } */
  const stringsOccurance = new Map();
  (typeof text === "string" ? terser.parse(text, {ecma: 2017}) : text).walk(new terser.TreeWalker(function (node) {
    switch (node.TYPE) {
    case "Function": case "Lambda":
      // @ts-ignore
      if (node.name && node.name.name === "VC") { return true }
      break
    case "String":
      /** @type { string } */
      // @ts-ignore
      const str = node.value
      if (str.length >= MIN_LONG_STRING) { stringsTooLong.push(str) }
      if (str.length >= MIN_STRING_LENGTH_TO_COMPUTE_GAIN) {
        /** @type { import("terser").TreeWalker } */
        const walker = this
        const parentNode = walker.parent(0)
        if (parentNode instanceof terser.AST_Case
           || parentNode instanceof terser.AST_Binary && parentNode.operator === "in") {
          break
        }
        stringsOccurance.set(str, (stringsOccurance.get(str) || 0) + 1)
      }
      break
    // no default
    }
    return false
  }))
  /** @type { Map<string, {count: number; gain: number}> } */
  const stringGains = new Map()
  for (let [str, count] of stringsOccurance) {
    if (count <= 1) { continue }
    const selfSize = str.length + (str.includes('"') && str.includes("'") ? 3 : 2)
    const gain = selfSize * count - (selfSize + /* def */ 4 + /* occ */ 2 * count)
    gain >= MIN_EXPECTED_STRING_GAIN && stringGains.set(str, { count, gain })
  }
  return {stringsTooLong, stringGains}
}
 
/**
 * @param { readonly string[][] } names
 * @param { ReadonlyMap<string, number> } countsMap
 * @return { string[] }
 */
function findDuplicated(names, countsMap) {
  /** @type { Map<string, number> } */
  const dedup = new Map();
  for (const arr of names) {
    for (let name of arr) {
      name = name[0] === ":" ? name.split(":")[1] : name;
      if (!countsMap.has(name)) { continue; }
      dedup.set(name, (dedup.get(name) || 0) + 1);
    }
  }
  const duplicated = [...dedup.entries()].filter(item => item[1] > 1).map(item => item[0]);
  return duplicated;
}

/**
 * @param { readonly string[][] } names
 * @param { number } minAllowedLength
 * @return { string[] }
 */
function findTooShort(names, minAllowedLength) {
  /** @type { Set<string> } */
  const short = new Set();
  for (const arr of names) {
    for (const name of arr) {
      if ((name[0] === ":" ? name.split(":")[1].length : name.length) < minAllowedLength) {
        short.add(name);
      }
    }
  }
  return [...short];
}

/**
 * @argument { string | string[] | { [file: string]: string } } files
 * @argument { MinifyOptions | null | undefined } options
 * @returns { MinifyOutput }
 */
function minify(files, options) {
  const sources = typeof files === "object" ? files instanceof Array ? files : Object.values(files) : [files];
  const ast = sources.length === 1 ? terser.parse(sources[0], options && options.parse) : sources.join("\n");
  /** @type { (() => void) | null | undefined } */
  let disposeNameMangler;
  if (options && options.mangle) {
    const { namesToMangle: names, namesCount: countsMap} = collectWords(ast, options);
    if (names.length > 0) {
      const duplicated = findDuplicated(names, countsMap);
      if (duplicated.length > 0) {
        throw Error("Find duplicated keys: " + JSON.stringify(duplicated, null, 2));
      }
      const tooShort = findTooShort(names, MIN_ALLOWED_NAME_LENGTH);
      if (tooShort.length > 0) {
        throw Error("Some keys are too short: " + JSON.stringify(tooShort, null, 2));
      }
      const variables = names.filter(arr => arr[0][0] === ":");
      if (variables.length > 2) {
        throw Error("Too many big closures to mangle: "
            + JSON.stringify(variables.map(list => list.slice(0, 16).map(i => i.split(":")[1]).concat(["..."]))));
      }
      if (variables.length < 1) {
        throw Error("No big closure found");
      }
      const properties = names.filter(arr => arr[0][0] !== ":");
      if (properties.length > MAX_ALLOWED_PROPERTY_GROUPS) {
        throw Error("Too many property groups to mangle: " + JSON.stringify(properties));
      }
      if (properties.length < 5 && properties.length > 0) {
        console.log("Find some property groups to mangle:", properties);
      }
      /** @type { NameCache } */
      // @ts-ignore
      const nameCache = options.nameCache || { vars: { props: {} }, props: { props: {} } };
      if (!nameCache.props) { nameCache.props = { props: {} }; }
      const props = nameCache.props.props || (nameCache.props.props = {});
      // @ts-ignore
      if (options.output && options.output.code) {
        disposeNameMangler = hookMangleNamesOnce(variables[0], variables.length > 1 ? variables[1] : null, countsMap)
      }
      for (const arr of properties) {
        const next = createMangler();
        for (const name of arr) {
          if (countsMap.has(name)) {
            let newName = next();
            for (; arr.includes(newName); newName = next()) { /* empty */ }
            props["$" + name] = newName;
          }
        }
      }
    }
  }
  const CHECK_WORDS = +(process.env.CHECK_WORDS || 0) > 0
  const minified = terser.minify(ast, { ...options,
    // @ts-ignore
    output: {...options.output, ast: CHECK_WORDS || options.output.ast }
  })
  disposeNameMangler && (disposeNameMangler(), disposeNameMangler = null)
  if (CHECK_WORDS) {
    const {stringsTooLong, stringGains} = collectString(minified.ast)
    if (stringsTooLong.length > 0) {
      console.log("Some strings are too long:")
      stringsTooLong.sort((i, j) => j.length - i.length)
      for (const str of stringsTooLong) {
        console.log("  (%s) %s", ("" + str.length).padStart(3, " "), str.length > 64 ? str.slice(0, 61) + "..." : str)
      }
    }
    if (CHECK_WORDS && stringGains.size > 0) {
      const gains = [...stringGains.entries()].sort((i, j) => j[1].gain - i[1].gain)
          .map(([i, {count, gain}]) => `${JSON.stringify(i)} (${count} times => ${gain})`)
          .join("\n  ")
      console.log("Some strings can be shared:\n  %s", gains)
    }
  }
  return minified
}

/**
 * @param { readonly string[] } mainVariableNames
 * @param { readonly string[] | null } extendClickValiables
 * @param { ReadonlyMap<string, number> } countsMap
 * @returns { () => void } dispose
 */
function hookMangleNamesOnce(mainVariableNames, extendClickValiables, countsMap) {
  const AST_Toplevel = require("terser").AST_Toplevel;
  // @ts-ignore
  const oldMangle = AST_Toplevel.prototype.mangle_names;
  const varCountMap = new Map([...countsMap].filter(i => i[0][0] === ":").map(([k, v]) => [k.split(":")[1], v]));
  /** @type { (this: AST_Scope, options: import("terser").MangleOptions) => any } */
  const myMangle = function (options) {
    const mainClosure = this.body ? this.body.filter(i => i.TYPE.includes("Statement"))[0] : null;
    /** @type { VariableMap } */
    // @ts-ignore
    const body = mainClosure && mainClosure.body, expression = body && body.expression,
    isVC = this.name && this.name.name === "VC"
    /** @type {Map<string, any>} */
    const astVariables = isVC ? this.variables : expression && expression.variables;
    if (!astVariables || !isVC && astVariables.size < MIN_COMPLEX_CLOSURE) { return; }
    const next = createMangler();
    const reserved = new Set([...(options.reserved || [])].concat([
      "do", "for", "if", "in", "new", "try", "var", "let"
    ]));
    const vars = isVC ? extendClickValiables : mainVariableNames
    for (const id of vars) {
      const name = id.split(":")[1]
      if (varCountMap.has(name)) {
        let newName = next();
        for (; vars.includes(newName) || reserved.has(newName); newName = next()) { /* empty */ }
        const varDef = astVariables.get(name);
        if (varDef) {
          varDef.mangled_name = newName;
        }
      }
    }
    const astVariableNameList = [...astVariables.keys()]
    const unknownVars = astVariableNameList.filter(k => !varCountMap.has(k) && k !== "arguments" && k !== "VC")
    if (unknownVars.length > 0) {
      console.log("Warning: some unknown variables in a closure:", unknownVars)
    }
    // const rareVars = astVariableNameList.filter(k => varCountMap.get(k) && varCountMap.get(k) <= 1)
    if (isVC) { return; }
    this.walk(new terser.TreeWalker(function (node) {
      switch (node.TYPE) {
      case "Function": case "Lambda":
        // @ts-ignore
        if (node.name && node.name.name === "VC") {
          myMangle.call(node, options)
          return true
        }
      }
      return false
    }))
    dispose()
    // @ts-ignore
    return this.mangle_names(options)
  };
  // @ts-ignore
  AST_Toplevel.prototype.mangle_names = myMangle;
  const dispose = () => {
    // @ts-ignore
    AST_Toplevel.prototype.mangle_names = oldMangle;
  }
  return dispose
}

/** @type { () => () => string } */
const createMangler = (function (doesTest) {
  /** @type { string[] } */
  const mangledNamesList = [];
  const _chars1 = "abcdefghijklmnopqrstuvwxyz", _chars2 = "0123456789",
  _chars3 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ", _chars4 = "_$",
  firstChars = doesTest ? _chars2 : _chars1 + _chars3 + _chars4,
  suffixChars = doesTest ? _chars2 + _chars4 : _chars1 + _chars2 + _chars3 + _chars4,
  n1 = firstChars.length, n2 = suffixChars.length;
  return () => {
    let counter = -1;
    return function nextName() {
      counter++;
      if (counter < mangledNamesList.length) {
        return mangledNamesList[counter];
      }
      let name = firstChars[counter % n1];
      for (let idx = (counter / n1) | 0; idx > 0; idx = (idx / n2) | 0) {
        idx--;
        name += suffixChars[idx % n2];
      }
      mangledNamesList.push(name);
      return name;
    }
  };
})(TEST);

if (typeof module !== "undefined") {
  module.exports = { minify };
}

if (TEST) {
  const next = createMangler(), arr = {};
  for (let i = 0; i < 300; i++) {
    arr[i] = next();
  }
  console.log(arr);
}
