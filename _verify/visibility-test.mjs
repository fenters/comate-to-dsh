/**
 * 模型可见性：取消勾选的模型不进 listModels，保存后重新加载仍然生效。
 *   node _verify/visibility-test.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

// 隔离数据目录，绝不碰用户真实的 selection.json。
const sandbox = mkdtempSync(join(tmpdir(), 'comate-visibility-'));
process.env.COMATE_TO_DSH_HOME = sandbox;

const { PATHS } = await import('../lib/config.mjs');
const { clearSelectionCache, readHiddenModels, setHiddenModels, setModelVisible } = await import('../lib/selection.mjs');
const { normalizeCatalog } = await import('../lib/catalog.mjs');
const { ComateAdapter } = await import('../lib/adapter.mjs');

try {
  check('数据目录已隔离', PATHS.selection.startsWith(sandbox), PATHS.selection);

  check('没有配置时没有隐藏模型', readHiddenModels().size === 0);

  const hidden = setModelVisible('enterprise/a/b//private', false);
  check('隐藏后写入配置', hidden.includes('enterprise/a/b//private'), JSON.stringify(hidden));
  clearSelectionCache();
  check('重新读盘仍然隐藏', readHiddenModels().has('enterprise/a/b//private'));

  setModelVisible('enterprise/a/b//private', true);
  clearSelectionCache();
  check('取消隐藏后不再隐藏', !readHiddenModels().has('enterprise/a/b//private'));

  setHiddenModels(['m1', '', '  ', 'm2', 'm1']);
  clearSelectionCache();
  check('批量覆盖去重并过滤空值', JSON.stringify([...readHiddenModels()].sort()) === '["m1","m2"]', JSON.stringify([...readHiddenModels()]));

  setModelVisible('', false);
  check('空 modelId 被忽略', !readHiddenModels().has(''));

  const catalog = normalizeCatalog({
    data: {
      items: [
        { name: '1/v/m1//private', display_name: 'M1', model_source: 'custom' },
        { name: '1/v/m2//public', display_name: 'M2', model_source: 'credits' },
        { name: '1/v/m3//public', display_name: 'M3', model_source: 'credits' },
      ],
    },
  }, []);
  const adapter = new ComateAdapter({ provider: 'comate', displayName: 'WPS Comate', client: {}, catalog });

  setHiddenModels([]);
  const before = await adapter.listModels('comate');
  check('未隐藏时三个模型都在', before.length === 3, `${before.length} 个`);

  setHiddenModels(['1/v/m1//private']);
  const after = await adapter.listModels('comate');
  check('隐藏后 listModels 少一个', after.length === 2, `${after.length} 个`);
  check('隐藏的是 m1', !after.some((model) => model.id === '1/v/m1//private'), after.map((model) => model.id).join(','));

  const resolved = await adapter.resolveModel('comate', '1/v/m1//private');
  check('resolveModel 仍能解析隐藏模型', resolved?.id === '1/v/m1//private' && resolved.name.includes('M1'), resolved.name);

  writeFileSync(PATHS.selection, '{ 坏掉的 json', 'utf8');
  clearSelectionCache();
  check('配置损坏时降级为全部可见', readHiddenModels().size === 0);
} finally {
  clearSelectionCache();
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n${failures ? `${failures} 项失败` : '全部通过'}`);
process.exit(failures ? 1 : 0);
