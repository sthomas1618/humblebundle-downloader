module.exports = {
  parser: '@typescript-eslint/parser',
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:unicorn/recommended',
    'prettier',
  ],
  rules: {
    semi: ['error', 'never'],
    'func-style': ['error', 'declaration'],
  },
}
