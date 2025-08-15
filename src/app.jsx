// Following is app.jsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import './index.css';

// Backend URLs (configure via environment variables at build time if needed)
const BACKEND_WS_URL = import.meta.env.VITE_BACKEND_WS_URL || 'ws://localhost:8000/ws';
const BACKEND_HTTP_BASE = import.meta.env.VITE_BACKEND_HTTP_BASE || 'http://localhost:8000';
const BACKEND_UPLOAD_URL = `${BACKEND_HTTP_BASE}/upload-training-audio/`;
const BACKEND_SYNC_MISTAKES_URL = `${BACKEND_HTTP_BASE}/sync-mistakes/`;

// Local storage-based persistence for training items (free-tier friendly, no external DB)
const LS_KEYS = {
  mistakes: 'qra_mistakes',
  trainingUploads: 'qra_training_uploads',
  userId: 'qra_user_id',
};

function App() {
  const [isListening, setIsListening] = useState(false);
  const [currentSura, setCurrentSura] = useState('');
  const [currentAya, setCurrentAya] = useState('');
  const [feedbackMode, setFeedbackMode] = useState('highlight'); // 'highlight', 'beep', 'spoken'
  const [mistakeQueue, setMistakeQueue] = useState([]); // {id, sura, aya, transcription, reference, type, timestamp, verified}
  const [currentVerseWords, setCurrentVerseWords] = useState([]);
  const [highlightedWords, setHighlightedWords] = useState([]); // Indices of words to highlight
  const [statusMessage, setStatusMessage] = useState('Ready to start listening.');
  const [isSpokenCorrectionPlaying, setIsSpokenCorrectionPlaying] = useState(false);
  const [currentTab, setCurrentTab] = useState('analyzer'); // 'analyzer', 'training', 'settings'
  const [userId, setUserId] = useState(null);
  const [recordedAudioFile, setRecordedAudioFile] = useState(null); // For initial Ruku/training uploads

  const [showCorrectionModal, setShowCorrectionModal] = useState(false);
  const [modalMistakeId, setModalMistakeId] = useState(null);
  const [modalReferenceText, setModalReferenceText] = useState('');
  const [isRecordingCorrectSample, setIsRecordingCorrectSample] = useState(false);
  const correctSampleRecorder = useRef(null);
  const correctSampleChunks = useRef([]);

  const ws = useRef(null);
  const audioContext = useRef(null);
  const mediaRecorder = useRef(null);
  const audioChunks = useRef([]);
  const audioStream = useRef(null);
  const spokenCorrectionSource = useRef(null);
  const animationFrameId = useRef(null);
  const silenceTimeoutId = useRef(null);
  const lastAudioTimestamp = useRef(0); // To help with silence detection if microphone stops sending

  // Initialize AudioContext on component mount
  useEffect(() => {
    if (!audioContext.current) {
      audioContext.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    // Cleanup AudioContext on unmount
    return () => {
      if (audioContext.current && audioContext.current.state !== 'closed') {
        audioContext.current.close();
      }
    };
  }, []);

  // Initialize or restore user id
  useEffect(() => {
    let uid = localStorage.getItem(LS_KEYS.userId);
    if (!uid) {
      uid = crypto.randomUUID();
      localStorage.setItem(LS_KEYS.userId, uid);
    }
    setUserId(uid);
  }, []);

  // Load mistakes from LocalStorage
  useEffect(() => {
    const saved = localStorage.getItem(LS_KEYS.mistakes);
    if (saved) {
      try {
        setMistakeQueue(JSON.parse(saved));
      } catch {}
    }
  }, []);

  // Persist mistakes to LocalStorage
  useEffect(() => {
    localStorage.setItem(LS_KEYS.mistakes, JSON.stringify(mistakeQueue));
  }, [mistakeQueue]);

  // Beep sound function for feedback
  const playBeep = useCallback(() => {
    if (audioContext.current) {
      const oscillator = audioContext.current.createOscillator();
      const gainNode = audioContext.current.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.current.destination);

      oscillator.type = 'sine';
      oscillator.frequency.value = 440; // Standard A4 note
      gainNode.gain.setValueAtTime(0.5, audioContext.current.currentTime);

      oscillator.start();
      // Ramp down the gain to avoid a click sound
      gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.current.currentTime + 0.1);
      oscillator.stop(audioContext.current.currentTime + 0.1);
    }
  }, []);

  // Play spoken correction audio received from the backend
  const playSpokenCorrection = useCallback(async (audioData) => {
    if (audioContext.current && audioData) {
      try {
        // Stop any currently playing spoken correction to prevent overlap
        if (spokenCorrectionSource.current) {
          spokenCorrectionSource.current.stop();
          spokenCorrectionSource.current.disconnect();
          spokenCorrectionSource.current = null;
          setIsSpokenCorrectionPlaying(false);
          console.log("Stopped previous spoken correction.");
        }

        // Decode the audio data (ArrayBuffer) into an AudioBuffer
        const audioBuffer = await audioContext.current.decodeAudioData(audioData.buffer);
        const source = audioContext.current.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContext.current.destination); // Connect to speakers

        // Set up callback for when playback ends
        source.onended = () => {
          setIsSpokenCorrectionPlaying(false);
          spokenCorrectionSource.current = null;
          console.log("Spoken correction ended naturally.");
        };

        source.start(0); // Start playback immediately
        spokenCorrectionSource.current = source; // Store reference to current source
        setIsSpokenCorrectionPlaying(true); // Update state to indicate playback
        console.log("Playing spoken correction.");
      } catch (error) {
        console.error('Error decoding or playing audio:', error);
        setStatusMessage('Error playing correction audio.');
        setIsSpokenCorrectionPlaying(false);
      }
    }
  }, []);

  // WebSocket connection and message handling for real-time analysis
  useEffect(() => {
    // If not listening, ensure WebSocket is closed
    if (!isListening) {
      if (ws.current) {
        ws.current.close();
        ws.current = null;
      }
      return;
    }

    // Establish WebSocket connection to the backend
    ws.current = new WebSocket(BACKEND_WS_URL);

    // Handle WebSocket open event
    ws.current.onopen = () => {
      console.log('WebSocket connected');
      setStatusMessage('Connected to server. Start reciting!');
      // Send initial configuration (like feedback mode) to the backend
      ws.current.send(JSON.stringify({ type: 'config', feedbackMode: feedbackMode }));
    };

    // Handle incoming messages from the WebSocket
    ws.current.onmessage = async (event) => {
      const message = JSON.parse(event.data);
      console.log('Received message:', message);

      if (message.type === 'verse_identified') {
        // Update UI with the identified Sura and Aya
        setCurrentSura(message.sura_name);
        setCurrentAya(message.ayah_text);
        // Split the Arabic text into words for individual highlighting.
        // Filters out empty strings from multiple spaces.
        setCurrentVerseWords(message.ayah_text.split(/\s+/).filter(word => word.length > 0));
        setStatusMessage(`Reciting: ${message.sura_name} - ${message.ayah_number}`);
        setHighlightedWords([]); // Clear previous highlights for new verse
      } else if (message.type === 'diff_update') {
        // Update highlights based on the real-time diff analysis
        // The 'diff' array contains objects like {type: 'equal'/'insertion'/'deletion'/'replacement_ref'/'replacement_trans', index, word}
        // We highlight words that are not 'equal' to indicate a discrepancy.
        // For visual clarity, specifically highlight words from the *reference* that are incorrect.
        const newHighlightedWords = message.diff
          .filter(d => d.type === 'deletion' || d.type === 'replacement_ref') // Highlight reference words that were deleted or replaced incorrectly
          .map(d => d.index);
        setHighlightedWords(newHighlightedWords);
      } else if (message.type === 'mistake_event') {
        // Display a detailed mistake message
        setStatusMessage(`Mistake detected! ${message.mistake_type} at word: "${message.reference_word}" (You said: "${message.transcribed_word}")`);

      // Prepare mistake data for storage
        const newMistake = {
          id: crypto.randomUUID(),
          sura: currentSura,
          aya: currentAya,
          transcription_segment: message.transcribed_segment,
          reference_segment: message.reference_segment,
          mistake_type: message.mistake_type,
          timestamp: Date.now(),
          verified: 'pending',
          synced: false,
        };
        setMistakeQueue(prev => [newMistake, ...prev]);

        // Trigger feedback based on user's selected mode
        if (feedbackMode === 'highlight') {
          // Highlighting is already handled by 'diff_update'
        } else if (feedbackMode === 'beep') {
          playBeep();
        } else if (feedbackMode === 'spoken' && message.correction_audio_base64) {
          // Decode base64 audio and play spoken correction
          const audioBytes = Uint8Array.from(atob(message.correction_audio_base64), c => c.charCodeAt(0));
          playSpokenCorrection(audioBytes);
        }
      }
    };

    // Handle WebSocket close event
    ws.current.onclose = () => {
      console.log('WebSocket disconnected');
      setStatusMessage('Disconnected from server.');
      setIsListening(false); // Stop listening if WS closes unexpectedly
    };

    // Handle WebSocket errors
    ws.current.onerror = (error) => {
      console.error('WebSocket error:', error);
      setStatusMessage('WebSocket error. Check server connection.');
      setIsListening(false); // Stop listening on error
    };

    // Cleanup function for useEffect: close WebSocket on component unmount or re-render
    return () => {
      if (ws.current) {
        ws.current.close();
      }
    };
  }, [isListening, feedbackMode, playBeep, playSpokenCorrection, currentSura, currentAya]);

  // Audio streaming logic for continuous microphone input to WebSocket
  const startListening = async () => {
    if (isListening) return; // Prevent multiple listening sessions

    try {
      // Request microphone access
      audioStream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Initialize MediaRecorder for webm audio format
      mediaRecorder.current = new MediaRecorder(audioStream.current, { mimeType: 'audio/webm' });
      audioChunks.current = []; // Clear previous audio chunks

      // Setup AudioContext Analyser for real-time sound level detection (for TTS interruption)
      const source = audioContext.current.createMediaStreamSource(audioStream.current);
      const analyser = audioContext.current.createAnalyser();
      analyser.fftSize = 2048; // Fast Fourier Transform size
      const bufferLength = analyser.frequencyBinCount; // Number of data points in the frequency domain
      const dataArray = new Uint8Array(bufferLength); // Array to hold the frequency data

      source.connect(analyser); // Connect microphone source to analyser

      // Function to continuously check for sound levels
      const checkSilence = () => {
        analyser.getByteFrequencyData(dataArray); // Populate dataArray with frequency data
        const sum = dataArray.reduce((a, b) => a + b, 0);
        const average = sum / bufferLength; // Calculate average sound level

        // If spoken correction is playing and user's microphone detects significant sound (user speaking)
        if (isSpokenCorrectionPlaying && average > 10) { // Threshold for detecting voice activity
          console.log("User started speaking, stopping TTS.");
          if (spokenCorrectionSource.current) {
            spokenCorrectionSource.current.stop(); // Stop TTS playback
            spokenCorrectionSource.current.disconnect();
            spokenCorrectionSource.current = null;
            setIsSpokenCorrectionPlaying(false);
          }
        }
        animationFrameId.current = requestAnimationFrame(checkSilence); // Continue checking in next animation frame
      };

      animationFrameId.current = requestAnimationFrame(checkSilence); // Start the silence detection loop

      // Event handler for when audio data is available from MediaRecorder
      mediaRecorder.current.ondataavailable = (event) => {
        audioChunks.current.push(event.data); // Add audio chunk to array
      };

      // Event handler for when MediaRecorder stops
      mediaRecorder.current.onstop = async () => {
        // Send any remaining accumulated audio chunks when recording stops
        if (audioChunks.current.length > 0 && ws.current && ws.current.readyState === WebSocket.OPEN) {
          const audioBlob = new Blob(audioChunks.current, { type: 'audio/webm' });
          const arrayBuffer = await audioBlob.arrayBuffer();
          ws.current.send(arrayBuffer); // Send as binary data over WebSocket
        }
        audioChunks.current = []; // Clear chunks
      };

      mediaRecorder.current.start(250); // Start recording, collecting data every 250ms
      setStatusMessage('Listening...');
      setIsListening(true); // Update listening status

      // Periodically send collected audio chunks to the backend
      const intervalId = setInterval(async () => {
        if (mediaRecorder.current && mediaRecorder.current.state === 'recording' && audioChunks.current.length > 0) {
          if (ws.current && ws.current.readyState === WebSocket.OPEN) {
            const audioBlob = new Blob(audioChunks.current, { type: 'audio/webm' });
            const arrayBuffer = await audioBlob.arrayBuffer();
            ws.current.send(arrayBuffer); // Send as binary ArrayBuffer
            lastAudioTimestamp.current = Date.now(); // Update timestamp of last sent audio
          }
          audioChunks.current = []; // Clear chunks after sending
        }
      }, 500); // Send accumulated chunks every 500ms

      // Cleanup function for interval on component unmount or stop
      return () => clearInterval(intervalId);

    } catch (error) {
      console.error('Error accessing microphone:', error);
      setStatusMessage('Microphone access denied or error. Please allow microphone permissions.');
      setIsListening(false);
    }
  };

  // Function to stop listening and clean up resources
  const stopListening = () => {
    if (!isListening) return;

    // Stop MediaRecorder if active
    if (mediaRecorder.current && mediaRecorder.current.state === 'recording') {
      mediaRecorder.current.stop();
    }
    // Stop all tracks in the audio stream (e.g., microphone)
    if (audioStream.current) {
      audioStream.current.getTracks().forEach(track => track.stop());
    }
    // Close WebSocket connection
    if (ws.current) {
      ws.current.close();
    }
    // Cancel animation frame for silence detection
    if (animationFrameId.current) {
      cancelAnimationFrame(animationFrameId.current);
    }
    // Clear any pending silence timeout (though less relevant now with real-time check)
    if (silenceTimeoutId.current) {
      clearTimeout(silenceTimeoutId.current);
    }

    // Reset UI states
    setIsListening(false);
    setStatusMessage('Stopped listening.');
    setCurrentSura('');
    setCurrentAya('');
    setCurrentVerseWords([]);
    setHighlightedWords([]);
    setIsSpokenCorrectionPlaying(false); // Ensure TTS playback is stopped
    if (spokenCorrectionSource.current) {
      spokenCorrectionSource.current.stop();
      spokenCorrectionSource.current.disconnect();
      spokenCorrectionSource.current = null;
    }
  };

  // Handler for changing feedback mode
  const handleFeedbackModeChange = (mode) => {
    setFeedbackMode(mode);
    // Send updated feedback mode to backend via WebSocket if connected
    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type: 'config', feedbackMode: mode }));
    }
  };

  // Handler for user verifying a detected mistake
  const handleMistakeVerification = async (id, status) => {
    setMistakeQueue(prev => prev.map(m => (m.id === id ? { ...m, verified: status, synced: false } : m)));
    setStatusMessage(`Mistake marked as ${status}.`);
  };

  // Handler for file selection for initial training audio upload
  const handleAudioFileUpload = (event) => {
    const file = event.target.files[0];
    if (file && file.type.startsWith('audio/')) {
      setRecordedAudioFile(file);
      setStatusMessage(`Audio file '${file.name}' selected for training.`);
    } else {
      setRecordedAudioFile(null);
      setStatusMessage("Please select a valid audio file (.mp3, .wav, etc.).");
    }
  };

  // Handler for uploading initial/Ruku training audio to backend
  const uploadInitialTrainingAudio = async () => {
    if (!recordedAudioFile) {
      setStatusMessage("No audio file selected to upload for training.");
      return;
    }

    setStatusMessage(`Uploading '${recordedAudioFile.name}' for training...`);

    const formData = new FormData();
    formData.append('file', recordedAudioFile, recordedAudioFile.name); // Append the audio file to form data

    try {
      // Send the audio file to the backend's upload endpoint
      const response = await fetch(BACKEND_UPLOAD_URL + `?sample_type=initial_recitation_upload`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const result = await response.json(); // Parse the JSON response from backend
      console.log('Initial training audio upload response:', result);
      setStatusMessage(`File '${recordedAudioFile.name}' uploaded successfully for initial training.`);

      // Store metadata locally for user's tracking
      const record = {
        id: crypto.randomUUID(),
        fileName: recordedAudioFile.name,
        type: 'initial_recitation_upload',
        timestamp: Date.now(),
        fileSize: recordedAudioFile.size,
        fileType: recordedAudioFile.type,
      };
      const existing = JSON.parse(localStorage.getItem(LS_KEYS.trainingUploads) || '[]');
      existing.unshift(record);
      localStorage.setItem(LS_KEYS.trainingUploads, JSON.stringify(existing));

      setRecordedAudioFile(null); // Clear selected file after successful upload
    } catch (error) {
      console.error("Error uploading initial training audio:", error);
      setStatusMessage("Failed to upload initial training audio.");
    }
  };

  // --- Correct Sample Recording Logic (for user-provided correct samples) ---
  const startRecordingCorrectSample = async (mistakeId, referenceText) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      correctSampleRecorder.current = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      correctSampleChunks.current = [];

      correctSampleRecorder.current.ondataavailable = (event) => {
        correctSampleChunks.current.push(event.data);
      };

      correctSampleRecorder.current.onstop = async () => {
        const audioBlob = new Blob(correctSampleChunks.current, { type: 'audio/webm' });
        correctSampleChunks.current = []; // Clear chunks

        // Upload the recorded correct sample to the backend
        await uploadCorrectSample(audioBlob, referenceText, mistakeId);
        // Stop the media stream tracks
        if (correctSampleRecorder.current && correctSampleRecorder.current.stream) {
          correctSampleRecorder.current.stream.getTracks().forEach(track => track.stop());
        }
        setIsRecordingCorrectSample(false); // Stop recording state
        setShowCorrectionModal(false); // Close modal
      };

      correctSampleRecorder.current.start();
      setIsRecordingCorrectSample(true);
      setStatusMessage("Recording your correct recitation...");
    } catch (error) {
      console.error("Error accessing microphone for correct sample:", error);
      setStatusMessage("Could not record correct sample. Microphone access denied.");
      setIsRecordingCorrectSample(false);
    }
  };

  const stopRecordingCorrectSample = () => {
    if (correctSampleRecorder.current && correctSampleRecorder.current.state === 'recording') {
      correctSampleRecorder.current.stop();
    }
    // Stop the media stream tracks if not already stopped by onstop event
    if (correctSampleRecorder.current && correctSampleRecorder.current.stream) {
      correctSampleRecorder.current.stream.getTracks().forEach(track => track.stop());
    }
    setIsRecordingCorrectSample(false);
    setStatusMessage("Correct sample recording stopped.");
  };

  const uploadCorrectSample = async (audioBlob, text, originalMistakeId) => {
    setStatusMessage("Uploading correct sample for training...");
    const formData = new FormData();
    // Use a specific filename format to identify these as correct samples for training
    const filename = `correct_recitation_${originalMistakeId || Date.now()}.webm`;
    formData.append('file', audioBlob, filename);

    try {
      const params = new URLSearchParams({ sample_type: 'correct_recitation_sample', reference_text: text || '', original_mistake_id: originalMistakeId || '' });
      const response = await fetch(`${BACKEND_UPLOAD_URL}?${params.toString()}`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const result = await response.json();
      console.log('Correct sample upload response:', result);
      setStatusMessage(`Correct sample for "${text}" uploaded successfully!`);

      // Store metadata locally for user's tracking
      const record = {
        id: crypto.randomUUID(),
        fileName: filename,
        text,
        originalMistakeId,
        type: 'correct_recitation_sample',
        timestamp: Date.now(),
        fileSize: audioBlob.size,
        fileType: audioBlob.type,
      };
      const existing = JSON.parse(localStorage.getItem(LS_KEYS.trainingUploads) || '[]');
      existing.unshift(record);
      localStorage.setItem(LS_KEYS.trainingUploads, JSON.stringify(existing));

    } catch (error) {
      console.error("Error uploading correct sample:", error);
      setStatusMessage("Failed to upload correct sample.");
    }
  };

  // Background sync of mistakes to backend JSONL
  const syncMistakes = useCallback(async () => {
    const unsynced = mistakeQueue.filter(m => !m.synced);
    if (unsynced.length === 0) return;
    try {
      const payload = { mistakes: unsynced.map(({ synced, ...rest }) => rest) };
      const res = await fetch(BACKEND_SYNC_MISTAKES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`Sync failed: ${res.status}`);
      // Mark as synced
      const syncedIds = new Set(unsynced.map(m => m.id));
      setMistakeQueue(prev => prev.map(m => (syncedIds.has(m.id) ? { ...m, synced: true } : m)));
      setStatusMessage('Synced mistakes to server.');
    } catch (e) {
      console.error('Sync mistakes error', e);
    }
  }, [mistakeQueue]);

  useEffect(() => {
    const interval = setInterval(() => {
      syncMistakes();
    }, 60000); // every 60s
    // initial attempt shortly after load
    const t = setTimeout(syncMistakes, 5000);
    return () => { clearInterval(interval); clearTimeout(t); };
  }, [syncMistakes]);

  return (
    <div className="min-h-screen bg-green-50 flex flex-col items-center p-4 sm:p-6 lg:p-8 font-inter">
      <header className="w-full max-w-4xl bg-green-700 text-white p-4 sm:p-6 rounded-lg shadow-xl mb-6 text-center">
        <h1 className="text-3xl sm:text-4xl font-bold mb-2">Quran Recitation Analyzer</h1>
        <p className="text-sm sm:text-base opacity-90">Real-time feedback for your Quran recitation.</p>
        {userId && (
          <p className="text-xs sm:text-sm mt-2 opacity-70">
            User ID: <span className="font-mono text-amber-200 break-all">{userId}</span>
          </p>
        )}
      </header>

      <nav className="w-full max-w-4xl bg-white p-2 rounded-lg shadow-md mb-6 flex justify-around items-center">
        <button
          className={`px-4 py-2 rounded-md font-medium transition-colors duration-200 ${
            currentTab === 'analyzer' ? 'bg-green-600 text-white shadow-md' : 'text-gray-700 hover:bg-gray-100'
          }`}
          onClick={() => setCurrentTab('analyzer')}
        >
          Analyzer
        </button>
        <button
          className={`px-4 py-2 rounded-md font-medium transition-colors duration-200 ${
            currentTab === 'training' ? 'bg-green-600 text-white shadow-md' : 'text-gray-700 hover:bg-gray-100'
          }`}
          onClick={() => setCurrentTab('training')}
        >
          Training
        </button>
        <button
          className={`px-4 py-2 rounded-md font-medium transition-colors duration-200 ${
            currentTab === 'settings' ? 'bg-green-600 text-white shadow-md' : 'text-gray-700 hover:bg-gray-100'
          }`}
          onClick={() => setCurrentTab('settings')}
        >
          Settings
        </button>
      </nav>

      {currentTab === 'analyzer' && (
        <main className="w-full max-w-4xl bg-white p-6 rounded-lg shadow-xl mb-6">
          <div className="flex flex-col items-center mb-6">
            <button
              onClick={isListening ? stopListening : startListening}
              className={`flex items-center justify-center px-8 py-4 rounded-full text-white font-bold text-lg sm:text-xl transition-all duration-300 transform hover:scale-105 shadow-lg
                ${isListening ? 'bg-red-500 hover:bg-red-600' : 'bg-green-500 hover:bg-green-600'}`}
            >
              {isListening ? (
                <>
                  <svg className="w-6 h-6 mr-3 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                  Stop Listening
                </>
              ) : (
                <>
                  <svg className="w-6 h-6 mr-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a4 4 0 01-4-4V7a4 4 0 014-4v0a4 4 0 014 4v0a4 4 0 01-4 4z"></path></svg>
                  Start Listening
                </>
              )}
            </button>
            <p className="mt-4 text-center text-gray-600 text-base sm:text-lg">{statusMessage}</p>
          </div>

          <div className="bg-gray-50 p-6 rounded-lg border border-gray-200 text-center min-h-[150px] flex flex-col justify-center">
            {currentSura && currentAya ? (
              <>
                <h2 className="text-2xl sm:text-3xl font-semibold text-green-800 mb-4">{currentSura}</h2>
                <p className="text-xl sm:text-2xl text-gray-800 leading-relaxed" dir="rtl">
                  {currentVerseWords.map((word, index) => (
                    <span
                      key={index}
                      className={`transition-colors duration-200 mx-0.5 ${
                        highlightedWords.includes(index) ? 'bg-red-200 font-bold text-red-700 rounded-md px-1' : ''
                      }`}
                    >
                      {word}
                    </span>
                  ))}
                </p>
              </>
            ) : (
              <p className="text-gray-500 text-lg">No verse identified yet. Please start reciting.</p>
            )}
          </div>
        </main>
      )}

      {currentTab === 'training' && (
        <div className="w-full max-w-4xl bg-white p-6 rounded-lg shadow-xl mb-6">
          <h2 className="text-2xl font-semibold text-green-800 mb-4">Training Data Management</h2>
          <p className="text-gray-700 mb-4">
            Review and verify detected mistakes. Your verified data and uploaded recitations help improve the AI model's accuracy for your voice.
          </p>

          <div className="mb-6 border-t border-gray-200 pt-4">
            <h3 className="text-xl font-medium text-green-700 mb-3">Upload Initial/Ruku Recitations</h3>
            <p className="text-gray-600 mb-3">
              Upload recordings of your Quran recitations (e.g., full Ruku's) to train the model on your unique voice, accent, and pronunciation patterns (including Guna, Madd, Seen/Sa, etc.).
            </p>
            <input
              type="file"
              accept="audio/*"
              onChange={handleAudioFileUpload}
              className="block w-full text-sm text-gray-700 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-green-50 file:text-green-700 hover:file:bg-green-100"
            />
            {recordedAudioFile && (
              <p className="mt-2 text-sm text-gray-500">Selected: {recordedAudioFile.name} ({Math.round(recordedAudioFile.size / 1024)} KB)</p>
            )}
            <button
              onClick={uploadInitialTrainingAudio}
              disabled={!recordedAudioFile}
              className="mt-4 px-6 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200"
            >
              Upload Audio for Training
            </button>
          </div>

          <h3 className="text-xl font-medium text-green-700 mb-3">Detected Mistakes Queue</h3>
          {mistakeQueue.length === 0 ? (
            <p className="text-gray-500">No mistakes recorded yet. Start reciting to generate data!</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full bg-white border border-gray-200 rounded-lg">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="py-2 px-4 border-b text-left text-sm font-semibold text-gray-600">Timestamp</th>
                    <th className="py-2 px-4 border-b text-left text-sm font-semibold text-gray-600">Sura/Aya</th>
                    <th className="py-2 px-4 border-b text-left text-sm font-semibold text-gray-600">Mistake Type</th>
                    <th className="py-2 px-4 border-b text-left text-sm font-semibold text-gray-600">Reference</th>
                    <th className="py-2 px-4 border-b text-left text-sm font-semibold text-gray-600">Transcribed</th>
                    <th className="py-2 px-4 border-b text-left text-sm font-semibold text-gray-600">Status</th>
                    <th className="py-2 px-4 border-b text-left text-sm font-semibold text-gray-600">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {mistakeQueue.map((mistake) => (
                    <tr key={mistake.id} className="border-b last:border-b-0 hover:bg-gray-50">
                      <td className="py-2 px-4 text-sm text-gray-800">{new Date(mistake.timestamp?.toDate ? mistake.timestamp.toDate() : mistake.timestamp).toLocaleString()}</td>
                      <td className="py-2 px-4 text-sm text-gray-800">{mistake.sura}</td>
                      <td className="py-2 px-4 text-sm text-gray-800 capitalize">{mistake.mistake_type.replace('_', ' ')}</td>
                      <td className="py-2 px-4 text-sm text-gray-800" dir="rtl">{mistake.reference_segment}</td>
                      <td className="py-2 px-4 text-sm text-gray-800" dir="rtl">{mistake.transcription_segment}</td>
                      <td className="py-2 px-4 text-sm text-gray-800">
                        <span className={`px-2 py-1 rounded-full text-xs font-semibold
                          ${mistake.verified === 'correct' ? 'bg-green-100 text-green-800' :
                            mistake.verified === 'incorrect' ? 'bg-red-100 text-red-800' : 'bg-yellow-100 text-yellow-800'}`}>
                          {mistake.verified}
                        </span>
                      </td>
                      <td className="py-2 px-4 text-sm">
                        {mistake.verified === 'pending' && (
                          <div className="flex space-x-2">
                            <button
                              onClick={() => handleMistakeVerification(mistake.id, 'incorrect')}
                              className="px-3 py-1 bg-red-500 text-white text-xs rounded-md hover:bg-red-600 transition-colors"
                              title="Confirm this was an actual mistake you made"
                            >
                              Mistake
                            </button>
                            <button
                              onClick={() => {
                                setModalMistakeId(mistake.id);
                                setModalReferenceText(mistake.reference_segment);
                                setShowCorrectionModal(true);
                              }}
                              className="px-3 py-1 bg-blue-500 text-white text-xs rounded-md hover:bg-blue-600 transition-colors"
                              title="The system was wrong, I recited this correctly. Record correct sample."
                            >
                              Correct (Recite)
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {currentTab === 'settings' && (
        <div className="w-full max-w-4xl bg-white p-6 rounded-lg shadow-xl mb-6">
          <h2 className="text-2xl font-semibold text-green-800 mb-4">Application Settings</h2>
          <div className="mb-4">
            <label className="block text-gray-700 text-lg font-medium mb-2">Feedback Mode:</label>
            <div className="flex flex-col space-y-3">
              <label className="inline-flex items-center text-lg">
                <input
                  type="radio"
                  className="form-radio h-5 w-5 text-green-600"
                  name="feedbackMode"
                  value="highlight"
                  checked={feedbackMode === 'highlight'}
                  onChange={() => handleFeedbackModeChange('highlight')}
                />
                <span className="ml-2 text-gray-800">Highlight: Visually highlights incorrect words.</span>
              </label>
              <label className="inline-flex items-center text-lg">
                <input
                  type="radio"
                  className="form-radio h-5 w-5 text-green-600"
                  name="feedbackMode"
                  value="beep"
                  checked={feedbackMode === 'beep'}
                  onChange={() => handleFeedbackModeChange('beep')}
                />
                <span className="ml-2 text-gray-800">Beep: Plays a simple sound effect on mistake.</span>
              </label>
              <label className="inline-flex items-center text-lg">
                <input
                  type="radio"
                  className="form-radio h-5 w-5 text-green-600"
                  name="feedbackMode"
                  value="spoken"
                  checked={feedbackMode === 'spoken'}
                  onChange={() => handleFeedbackModeChange('spoken')}
                />
                <span className="ml-2 text-gray-800">Spoken Correction: Plays an audio correction.</span>
              </label>
            </div>
          </div>
        </div>
      )}

      {/* Correct Sample Recording Modal */}
      {showCorrectionModal && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg p-6 shadow-xl max-w-md w-full text-center">
            <h3 className="text-xl font-semibold text-green-800 mb-4">Provide Correct Sample</h3>
            <p className="text-gray-700 mb-4">
              The system thought you made a mistake here, but you said you recited it correctly. Please recite the following text correctly now to help train the AI:
            </p>
            <p className="text-2xl text-green-700 font-bold mb-6" dir="rtl">{modalReferenceText}</p>
            <div className="flex justify-center space-x-4">
              <button
                onClick={isRecordingCorrectSample ? stopRecordingCorrectSample : () => startRecordingCorrectSample(modalMistakeId, modalReferenceText)}
                className={`px-6 py-3 rounded-full text-white font-bold transition-all duration-200 shadow-md
                  ${isRecordingCorrectSample ? 'bg-red-500 hover:bg-red-600' : 'bg-blue-500 hover:bg-blue-600'}`}
              >
                {isRecordingCorrectSample ? 'Stop Recording' : 'Start Recording'}
              </button>
              <button
                onClick={() => {
                  if (isRecordingCorrectSample) stopRecordingCorrectSample(); // Stop if recording
                  setShowCorrectionModal(false); // Close modal
                  setModalMistakeId(null);
                  setModalReferenceText('');
                }}
                className="px-6 py-3 bg-gray-300 text-gray-800 rounded-full hover:bg-gray-400 transition-colors duration-200 shadow-md"
              >
                Cancel
              </button>
            </div>
            {isRecordingCorrectSample && (
              <p className="mt-4 text-sm text-gray-600 animate-pulse">Recording... Speak clearly.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App; // Export App (though not strictly necessary for a single-file app, good practice)
