declare module '*.css' {
  const content: Record<string, unknown>;
  export default content;
}

declare module '*.vue' {
  import { DefineComponent } from 'vue';
  const component: DefineComponent<{}, {}, any>;
  export default component;
}
