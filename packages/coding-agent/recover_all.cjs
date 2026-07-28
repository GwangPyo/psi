const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const historyDir = '/home/yoo/.vscode-server/data/User/History';
const workspaceRoot = '/home/yoo/supergravity/pi/packages/coding-agent';

// Files that were known to be modified before the reset
const targetFiles = [
    '../ai/src/providers/fireworks.models.ts',
    '../ai/src/providers/huggingface.models.ts',
    '../ai/src/providers/nvidia.models.ts',
    '../ai/src/providers/opencode.models.ts',
    '../ai/src/providers/openrouter.models.ts',
    '../ai/src/providers/together.models.ts',
    '../ai/src/providers/vercel-ai-gateway.models.ts',
    'src/core/compaction/utils.ts',
    'src/core/system-prompt.ts',
    'src/extensions/adversarial-conversation/index.ts',
    'src/extensions/plan/fsm/machine.ts',
    'src/extensions/plan/fsm/presentation.ts',
    'src/extensions/plan/fsm/schema.ts',
    'src/extensions/plan/fsm/validator.ts',
    'src/extensions/plan/guide.ts',
    'src/extensions/plan/prompt.ts',
    'src/extensions/plan/tui-graph.ts',
    'test/plan-fsm-extension.test.ts',
    'src/extensions/plan/index.ts',
    'test/plan-fsm.test.ts'
];

let restoredCount = 0;

fs.readdirSync(historyDir).forEach(dir => {
    const entriesPath = path.join(historyDir, dir, 'entries.json');
    if (fs.existsSync(entriesPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(entriesPath, 'utf8'));
            const resource = data.resource || '';
            
            for (const target of targetFiles) {
                // Normalize target path to match VSCode resource URL format
                const normalizedTarget = target.replace('../', '');
                
                if (resource.endsWith(normalizedTarget)) {
                    if (data.entries && data.entries.length > 0) {
                        // Find the latest entry
                        const latestEntry = data.entries[data.entries.length - 1];
                        const sourcePath = path.join(historyDir, dir, latestEntry.id);
                        
                        let destPath;
                        if (target.startsWith('../')) {
                            destPath = path.join('/home/yoo/supergravity/pi/packages', target.substring(3));
                        } else {
                            destPath = path.join(workspaceRoot, target);
                        }
                        
                        // Ensure directory exists
                        fs.mkdirSync(path.dirname(destPath), { recursive: true });
                        fs.copyFileSync(sourcePath, destPath);
                        console.log(`Restored ${target} from ${latestEntry.id} (timestamp: ${latestEntry.timestamp})`);
                        restoredCount++;
                    }
                }
            }
        } catch(e) {
            // Ignore parse errors
        }
    }
});

console.log(`Finished restoring ${restoredCount} files.`);
