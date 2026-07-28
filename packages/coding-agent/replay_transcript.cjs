const fs = require('fs');

const transcriptPath = '/home/yoo/.gemini/antigravity-cli/brain/606ae6e8-dfe0-43af-9e67-bca6ad007408/.system_generated/logs/transcript_full.jsonl';
const workspace = '/home/yoo/supergravity/pi/packages/coding-agent';

const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter(Boolean);

let foundReset = false;

for (const line of lines) {
    try {
        const step = JSON.parse(line);
        
        // Stop if we reach the point where we did git reset --hard
        if (step.type === 'RUN_COMMAND' && step.content && step.content.includes('git reset --hard')) {
            foundReset = true;
            break;
        }

        if (step.tool_calls) {
            for (const call of step.tool_calls) {
                if (call.name === 'multi_replace_file_content' || call.name === 'replace_file_content') {
                    const args = call.args;
                    const file = args.TargetFile || args.Target;
                    
                    if (!file.includes(workspace)) continue;
                    
                    console.log(`Replaying ${call.name} on ${file} (step ${step.step_index})`);
                    
                    let content = '';
                    if (fs.existsSync(file)) {
                        content = fs.readFileSync(file, 'utf8');
                    }
                    
                    if (call.name === 'multi_replace_file_content') {
                        // Apply replacement chunks (assuming simple string replacement for now, 
                        // though line numbers would be more accurate if there were duplicates. 
                        // Our tool uses literal exact match).
                        for (const chunk of args.ReplacementChunks) {
                            if (content.includes(chunk.TargetContent)) {
                                content = content.replace(chunk.TargetContent, chunk.ReplacementContent);
                            } else {
                                console.warn(`  Warning: TargetContent not found in ${file}`);
                            }
                        }
                    } else if (call.name === 'replace_file_content') {
                        if (content.includes(args.TargetContent)) {
                            content = content.replace(args.TargetContent, args.ReplacementContent);
                        } else {
                            console.warn(`  Warning: TargetContent not found in ${file}`);
                        }
                    }
                    
                    fs.writeFileSync(file, content, 'utf8');
                } else if (call.name === 'write_to_file') {
                    const file = call.args.TargetFile;
                    if (!file.includes(workspace)) continue;
                    console.log(`Replaying write_to_file on ${file} (step ${step.step_index})`);
                    fs.writeFileSync(file, call.args.CodeContent, 'utf8');
                }
            }
        }
    } catch(e) {
        // console.error("Parse error:", e.message);
    }
}
console.log("Replay finished.");
