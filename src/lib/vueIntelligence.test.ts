import { describe, expect, it } from "vitest";
import {
  collectVueSymbols,
  vueCompletionSymbolsForPosition,
  vueOutlineSymbols,
} from "./vueIntelligence";

const optionsApi = `
<template>
  <MyPanel :title="menuTitle" @click="handleClick">{{ currentLang }}</MyPanel>
</template>
<script>
import MyPanel from './components/MyPanel.vue'
export default {
  components: { MyPanel },
  props: ['initialLang'],
  data() {
    return {
      currentLang: 'en',
      showPanel: true,
    }
  },
  computed: {
    menuTitle() {
      return this.currentLang
    }
  },
  methods: {
    async handleClick() {
      this.currentLang = 'fr'
    }
  }
}
</script>
`;

describe("vueIntelligence", () => {
  it("collects Options API symbols for completion and outline", () => {
    const names = collectVueSymbols(optionsApi).map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain("component:MyPanel");
    expect(names).toContain("prop:initialLang");
    expect(names).toContain("data:currentLang");
    expect(names).toContain("computed:menuTitle");
    expect(names).toContain("method:handleClick");
  });

  it("suggests instance members after this-dot", () => {
    const line = lineOf(optionsApi, "this.currentLang");
    const column = optionsApi.split("\n")[line - 1].indexOf("this.") + "this.".length + 1;
    const names = vueCompletionSymbolsForPosition(optionsApi, line, column).map((s) => s.name);
    expect(names).toContain("currentLang");
    expect(names).toContain("menuTitle");
    expect(names).toContain("handleClick");
  });

  it("suggests local components in template tag position", () => {
    const source = optionsApi.replace("<MyPanel", "<");
    const line = lineOf(source, "< :title");
    const column = source.split("\n")[line - 1].indexOf("<") + 2;
    const names = vueCompletionSymbolsForPosition(source, line, column).map((s) => s.name);
    expect(names).toContain("MyPanel");
  });

  it("collects script setup bindings", () => {
    const source = `
<script setup>
import ChildCard from './ChildCard.vue'
const count = ref(0)
function increment() {}
</script>
<template>{{ count }}</template>
`;
    const names = vueOutlineSymbols(source).map((s) => `${s.kind}:${s.name}`);
    expect(names).toContain("component:ChildCard");
    expect(names).toContain("setup:count");
    expect(names).toContain("method:increment");
  });
});

function lineOf(source: string, needle: string) {
  const before = source.slice(0, source.indexOf(needle));
  return before.split("\n").length;
}
