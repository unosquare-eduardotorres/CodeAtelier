/**
 * techIcons — Maps detected technology names to devicon CDN SVG URLs.
 *
 * Uses the devicon library via jsDelivr CDN (zero bundle impact).
 * Falls back to null when no match is found (callers render a generic icon).
 */

const TECH_ICON_MAP: Record<string, string> = {
  // JavaScript / TypeScript ecosystem
  react: 'react',
  typescript: 'typescript',
  javascript: 'javascript',
  'node.js': 'nodejs',
  nodejs: 'nodejs',
  node: 'nodejs',
  express: 'express',
  'express.js': 'express',
  nextjs: 'nextjs',
  'next.js': 'nextjs',
  nuxt: 'nuxtjs',
  'nuxt.js': 'nuxtjs',
  vue: 'vuejs',
  'vue.js': 'vuejs',
  angular: 'angularjs',
  svelte: 'svelte',
  electron: 'electron',
  vite: 'vitejs',
  webpack: 'webpack',
  eslint: 'eslint',
  prettier: 'prettier',
  jest: 'jest',
  mocha: 'mocha',
  vitest: 'vitest',
  playwright: 'playwright',
  cypress: 'cypressio',
  babel: 'babel',
  npm: 'npm',
  yarn: 'yarn',
  pnpm: 'pnpm',

  // CSS / Styling
  tailwindcss: 'tailwindcss',
  'tailwind css': 'tailwindcss',
  tailwind: 'tailwindcss',
  css: 'css3',
  sass: 'sass',
  scss: 'sass',
  less: 'less',
  bootstrap: 'bootstrap',

  // Backend / Systems
  python: 'python',
  rust: 'rust',
  go: 'go',
  golang: 'go',
  java: 'java',
  kotlin: 'kotlin',
  swift: 'swift',
  ruby: 'ruby',
  php: 'php',
  'c#': 'csharp',
  csharp: 'csharp',
  '.net': 'dotnetcore',
  dotnet: 'dotnetcore',
  'asp.net': 'dotnetcore',

  // Databases
  postgresql: 'postgresql',
  postgres: 'postgresql',
  mysql: 'mysql',
  sqlite: 'sqlite',
  mongodb: 'mongodb',
  redis: 'redis',
  supabase: 'supabase',
  firebase: 'firebase',

  // DevOps / Infra
  docker: 'docker',
  kubernetes: 'kubernetes',
  k8s: 'kubernetes',
  terraform: 'terraform',
  aws: 'amazonwebservices',
  azure: 'azure',
  gcp: 'googlecloud',
  'google cloud': 'googlecloud',
  nginx: 'nginx',
  linux: 'linux',

  // Tools / VCS
  git: 'git',
  github: 'github',
  gitlab: 'gitlab',
  bitbucket: 'bitbucket',

  // APIs / Data
  graphql: 'graphql',
  html: 'html5',
  html5: 'html5',

  // Misc frameworks
  django: 'django',
  flask: 'flask',
  fastapi: 'fastapi',
  spring: 'spring',
  rails: 'rails',
  'ruby on rails': 'rails',
  laravel: 'laravel'
}

/**
 * Returns a devicon CDN URL for the given tech name, or null if unrecognized.
 */
export function getDeviconUrl(tech: string): string | null {
  const key = tech.toLowerCase().trim()
  const icon = TECH_ICON_MAP[key]
  if (!icon) return null
  return `https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/${icon}/${icon}-original.svg`
}

/**
 * Returns the devicon icon name (without URL) for a tech, or null.
 */
export function getTechIconName(tech: string): string | null {
  return TECH_ICON_MAP[tech.toLowerCase().trim()] ?? null
}
