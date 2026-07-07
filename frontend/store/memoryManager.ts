import { useWorkflowStore } from './workflowStore';
import { BACKEND_URL } from '../src/config';

const MAX_RECENT_TURNS = 6;

export const useMemoryManager = () => {
  const store = useWorkflowStore();

  const compressIfNeeded = async () => {
    const { recentTurns, conversationSummary } = useWorkflowStore.getState();
    
    // Only compress if we exceed the threshold
    if (recentTurns.length > MAX_RECENT_TURNS) {
      const turnsToCompress = recentTurns.slice(0, 4);
      const turnsToKeep = recentTurns.slice(4);
      
      // Build a compression prompt using the existing /chat endpoint
      const historyText = turnsToCompress
        .map((t: any) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
        .join('\n');
      
      try {
        const response = await fetch(`${BACKEND_URL}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_message: `Compress this conversation into a 2-3 sentence summary for context. Existing summary: "${conversationSummary}". New turns:\n${historyText}`,
            session_id: 'memory_compress',
            scene_id: null,
          })
        });

        if (response.ok) {
          const data = await response.json();
          const newSummary = data.chat_reply || conversationSummary;
          useWorkflowStore.setState({ 
            conversationSummary: newSummary,
            recentTurns: turnsToKeep 
          });
        } else {
          // If request fails, just prune to avoid token overflow
          useWorkflowStore.setState({ recentTurns: turnsToKeep });
        }
      } catch (error) {
        console.error('[MemoryManager] Compression failed, pruning:', error);
        useWorkflowStore.setState({ recentTurns: turnsToKeep }); 
      }
    }
  };

  const updateSceneSummary = (device: string, currentState: string, warnings: string[], confidence: number, sceneHash: string) => {
    const { sceneSummary } = useWorkflowStore.getState();
    const currentVersion = sceneSummary ? sceneSummary.version : 0;
    
    useWorkflowStore.setState({
      sceneSummary: {
        device,
        currentState,
        warnings,
        confidence,
        sceneHash,
        version: currentVersion + 1,
        timestamp: Date.now()
      }
    });
  };

  const checkVisualTriggers = (newConfidence: number, newHash: string) => {
    const { sceneSummary } = useWorkflowStore.getState();
    if (!sceneSummary) return false;

    // Refresh if confidence drops significantly or scene hash completely changes
    if (newConfidence < 40 && sceneSummary.confidence >= 60) {
      return true;
    }
    
    if (newHash && sceneSummary.sceneHash && newHash !== sceneSummary.sceneHash) {
      return true;
    }
    
    return false;
  };

  return { compressIfNeeded, updateSceneSummary, checkVisualTriggers };
};
