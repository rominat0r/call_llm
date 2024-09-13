import express, { Response } from 'express';
import ExpressWs from 'express-ws';
import { WebSocket } from 'ws';
import VoiceResponse from 'twilio/lib/twiml/VoiceResponse';
import { Llm } from './llm';
import { Stream } from './stream';
import { TextToSpeech } from './text-to-speech';
import { ElevenLabsAlpha } from 'elevenlabs-alpha'
const speech = require('@google-cloud/speech').v1p1beta1;

const app = ExpressWs(express()).app;
const PORT: number = parseInt(process.env.PORT || '8080');

const client = new speech.SpeechClient();

export const startApp = () => {
  
  app.ws('/call/connection', (ws: WebSocket) => {
    let isAssistantSpeaking = false;
   
    console.log('Twilio -> Connection opened'.underline.green);

    ws.on('error', console.error);

    const llm = new Llm();
    const stream = new Stream(ws);
    const textToSpeech = new TextToSpeech();

    let streamSid: string;
    let callSid: string;
    let marks: string[] = [];
    
    const recognizeStream = client
    .streamingRecognize({
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: 16000, 
        languageCode: 'en-US', 
       
      },
      interimResults: true,
    })
    .on('error', console.error)
    .on('data', (data:any) => {
      console.dir(data);
    });
    
    // Incoming from MediaStream
    ws.on('message', (audioChunk: Buffer) => {
      console.log(audioChunk);
      // const audioBuffer = Buffer.from(message.media.payload, 'base64');
      if (recognizeStream.writable) {
        recognizeStream.write(audioChunk); 
      } else {
        console.error('Recognize stream is not writable');
      }

    
    });

    llm.on('llmreply', async (llmReply: { partialResponse: string }) => {
      console.log(`LLM -> TTS: ${llmReply.partialResponse}`.green);
      textToSpeech.generate(llmReply);
    });

    textToSpeech.on(
      'speech',
      (responseIndex: number, audio: string, label: string) => {
        isAssistantSpeaking = true;
        console.log('speaking');
        console.log(`TTS -> TWILIO: ${label}`.blue);
        stream.buffer(responseIndex, audio);

        const estimatedDurationMs = audio.length / 5.5;
        console.log(`Estimated duration: ${estimatedDurationMs}ms`);
        setTimeout( () => {
          isAssistantSpeaking = false;
          console.log('end of speech');
        }, estimatedDurationMs);
      },
    );

    stream.on('audiosent', (markLabel: string) => {
      marks.push(markLabel);
    });
  });

  app.listen(PORT, () => {
    console.log(`Local: http://localhost:${PORT}`);
    console.log(`Remote: https://${process.env.SERVER_DOMAIN}`);
  });
};
