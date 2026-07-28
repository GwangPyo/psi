const fs = require('fs');
const path = require('path');

const historyDir = '/home/yoo/.vscode-server/data/User/History';
const targetFiles = [
    'src/core/compaction/utils.ts',
    'src/core/system-prompt.ts',
    'src/extensions/adversarial-conversation/index.ts',
    'src/extensions/plan/fsm/machine.ts',
    'src/extensions/plan/fsm/presentation.ts',
    'src/extensions/plan/fsm/validator.ts',
    'src/extensions/plan/prompt.ts',
    'src/extensions/plan/tui-graph.ts',
    'test/plan-fsm-extension.test.ts',
    'src/extensions/plan/index.ts'
];

const workspaceRoot = '/home/yoo/supergravity/pi/packages/coding-agent';

fs.readdirSync(historyDir).forEach(dir => {
    const entriesPath = path.join(historyDir, dir, 'entries.json');
    if (fs.existsSync(entriesPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(entriesPath, 'utf8'));
            const resource = data.resource || '';
            const matches = targetFiles.find(f => resource.endsWith(f));
            if (matches) {
                const latestEntry = data.entries[data.entries.length - 1];
                if (latestEntry) {
                    const sourcePath = path.join(historyDir, dir, latestEntry.id);
                    const destPath = path.join(workspaceRoot, matches);
                    fs.copyFileSync(sourcePath, destPath);
                    console.log(`Restored ${matches} from ${sourcePath}`);
                }
            }
        } catch(e) {}
    }
});
