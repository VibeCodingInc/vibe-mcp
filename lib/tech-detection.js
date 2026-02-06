/**
 * Tech Stack Detection
 *
 * Automatically detects the tech stack from the current project directory.
 * Used for better matching in discovery and recommendations.
 */

const fs = require('fs');
const path = require('path');

// Common tech indicators by file
const TECH_FILES = {
  'package.json': ['javascript', 'node'],
  'tsconfig.json': ['typescript'],
  'requirements.txt': ['python'],
  'pyproject.toml': ['python'],
  'Cargo.toml': ['rust'],
  'go.mod': ['go'],
  'Gemfile': ['ruby'],
  'composer.json': ['php'],
  'build.gradle': ['java', 'kotlin'],
  'pom.xml': ['java'],
  'Package.swift': ['swift'],
  'pubspec.yaml': ['dart', 'flutter'],
  'Dockerfile': ['docker'],
  'docker-compose.yml': ['docker'],
  '.github/workflows': ['github-actions'],
  'vercel.json': ['vercel'],
  'netlify.toml': ['netlify'],
};

// Framework/library detection from package.json
const NPM_FRAMEWORKS = {
  'react': 'react',
  'react-dom': 'react',
  'next': 'nextjs',
  'vue': 'vue',
  'nuxt': 'nuxt',
  '@angular/core': 'angular',
  'svelte': 'svelte',
  'express': 'express',
  'fastify': 'fastify',
  'hono': 'hono',
  'prisma': 'prisma',
  'drizzle-orm': 'drizzle',
  '@vercel/kv': 'vercel-kv',
  'tailwindcss': 'tailwind',
  'langchain': 'langchain',
  'openai': 'openai',
  '@anthropic-ai/sdk': 'anthropic',
  'playwright': 'playwright',
  'vitest': 'vitest',
  'jest': 'jest',
};

// Python library detection
const PYTHON_FRAMEWORKS = {
  'django': 'django',
  'flask': 'flask',
  'fastapi': 'fastapi',
  'langchain': 'langchain',
  'openai': 'openai',
  'anthropic': 'anthropic',
  'torch': 'pytorch',
  'tensorflow': 'tensorflow',
  'pandas': 'pandas',
  'numpy': 'numpy',
};

/**
 * Detect tech stack from current working directory
 * @param {string} dir - Directory to analyze (defaults to process.cwd())
 * @returns {Object} { languages: string[], frameworks: string[], tools: string[] }
 */
function detectTechStack(dir = process.cwd()) {
  const languages = new Set();
  const frameworks = new Set();
  const tools = new Set();

  try {
    const files = fs.readdirSync(dir);

    // Check for tech indicator files
    for (const [file, techs] of Object.entries(TECH_FILES)) {
      if (files.includes(file) || files.includes(file.split('/')[0])) {
        techs.forEach(t => {
          if (['javascript', 'typescript', 'python', 'rust', 'go', 'ruby', 'php', 'java', 'kotlin', 'swift', 'dart'].includes(t)) {
            languages.add(t);
          } else {
            tools.add(t);
          }
        });
      }
    }

    // Parse package.json for npm dependencies
    const packageJsonPath = path.join(dir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        const deps = {
          ...pkg.dependencies,
          ...pkg.devDependencies,
        };

        for (const [dep, framework] of Object.entries(NPM_FRAMEWORKS)) {
          if (deps[dep]) {
            frameworks.add(framework);
          }
        }

        // Detect from package.json scripts
        if (pkg.scripts) {
          if (pkg.scripts.test?.includes('vitest')) frameworks.add('vitest');
          if (pkg.scripts.test?.includes('jest')) frameworks.add('jest');
          if (pkg.scripts.start?.includes('next')) frameworks.add('nextjs');
        }
      } catch (e) {
        // Ignore parse errors
      }
    }

    // Parse requirements.txt for Python dependencies
    const requirementsPath = path.join(dir, 'requirements.txt');
    if (fs.existsSync(requirementsPath)) {
      try {
        const content = fs.readFileSync(requirementsPath, 'utf8');
        for (const [dep, framework] of Object.entries(PYTHON_FRAMEWORKS)) {
          if (content.toLowerCase().includes(dep)) {
            frameworks.add(framework);
          }
        }
      } catch (e) {
        // Ignore read errors
      }
    }

    // Parse pyproject.toml for Python dependencies
    const pyprojectPath = path.join(dir, 'pyproject.toml');
    if (fs.existsSync(pyprojectPath)) {
      try {
        const content = fs.readFileSync(pyprojectPath, 'utf8');
        for (const [dep, framework] of Object.entries(PYTHON_FRAMEWORKS)) {
          if (content.toLowerCase().includes(dep)) {
            frameworks.add(framework);
          }
        }
      } catch (e) {
        // Ignore read errors
      }
    }

    // Check for AI/ML indicators
    const aiIndicators = ['openai', 'anthropic', 'langchain', 'pytorch', 'tensorflow'];
    if (aiIndicators.some(f => frameworks.has(f))) {
      tools.add('ai');
    }

    // Check for MCP indicators
    if (files.some(f => f.includes('mcp')) ||
        (fs.existsSync(packageJsonPath) &&
         fs.readFileSync(packageJsonPath, 'utf8').includes('@modelcontextprotocol'))) {
      tools.add('mcp');
    }

  } catch (e) {
    // Directory not accessible, return empty
  }

  return {
    languages: Array.from(languages),
    frameworks: Array.from(frameworks),
    tools: Array.from(tools),
  };
}

/**
 * Get tech stack as tags for matching
 * @param {string} dir - Directory to analyze
 * @returns {string[]} Combined list of tech tags
 */
function getTechTags(dir = process.cwd()) {
  const stack = detectTechStack(dir);
  return [...stack.languages, ...stack.frameworks, ...stack.tools];
}

/**
 * Get a one-liner description of the tech stack
 * @param {string} dir - Directory to analyze
 * @returns {string} e.g., "TypeScript + Next.js + Vercel"
 */
function getTechOneLiner(dir = process.cwd()) {
  const stack = detectTechStack(dir);

  const parts = [];

  // Primary language
  if (stack.languages.includes('typescript')) {
    parts.push('TypeScript');
  } else if (stack.languages.includes('javascript')) {
    parts.push('JavaScript');
  } else if (stack.languages.length > 0) {
    parts.push(stack.languages[0].charAt(0).toUpperCase() + stack.languages[0].slice(1));
  }

  // Main framework
  const mainFrameworks = ['nextjs', 'react', 'vue', 'angular', 'svelte', 'django', 'fastapi', 'express'];
  for (const fw of mainFrameworks) {
    if (stack.frameworks.includes(fw)) {
      const displayName = {
        'nextjs': 'Next.js',
        'react': 'React',
        'vue': 'Vue',
        'angular': 'Angular',
        'svelte': 'Svelte',
        'django': 'Django',
        'fastapi': 'FastAPI',
        'express': 'Express',
      }[fw] || fw;
      parts.push(displayName);
      break;
    }
  }

  // Key tools
  if (stack.tools.includes('ai')) {
    parts.push('AI');
  }
  if (stack.tools.includes('mcp')) {
    parts.push('MCP');
  }
  if (stack.tools.includes('vercel')) {
    parts.push('Vercel');
  }

  return parts.join(' + ') || 'Unknown stack';
}

module.exports = {
  detectTechStack,
  getTechTags,
  getTechOneLiner,
};
