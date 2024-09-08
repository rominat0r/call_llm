import express, { Response } from 'express';
import ExpressWs from 'express-ws';
import { WebSocket } from 'ws';
import VoiceResponse from 'twilio/lib/twiml/VoiceResponse';
import { Llm } from './llm';
import { Stream } from './stream';
import { TextToSpeech } from './text-to-speech';
import { ElevenLabsAlpha } from 'elevenlabs-alpha';
const speech = require('@google-cloud/speech').v1p1beta1;

const app = ExpressWs(express()).app;
const PORT: number = parseInt(process.env.PORT || '8080');

const elevenlabs = new ElevenLabsAlpha();
const client = new speech.SpeechClient();

export const startApp = () => {
  
  app.post('/call/incoming', (_, res: Response) => {
    const twiml = new VoiceResponse();

    twiml.connect().stream({
      url: `wss://${process.env.SERVER_DOMAIN}/call/connection`,
    });

    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
  });

  app.ws('/call/connection', (ws: WebSocket) => {
    
   
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
        encoding: 'MULAW', 
        sampleRateHertz: 8000, 
        languageCode: 'en-US', 
        enableSpeakerDiarization: true,
        minSpeakerCount: 1,
        maxSpeakerCount: 2,
        model: 'phone_call',
      },
      interimResults: true,
    })
    .on('error', console.error)
    .on('data', (data:any) => {
      console.log(data.results[0].alternatives[0].words);


      if (data.results[0] && data.results[0].isFinal) {

        const transcription = data.results[0].alternatives[0].transcript;
        if (transcription && marks.length === 0) {
          
          console.log(`Transcription – STT -> LLM: ${transcription}`.yellow);
          llm.completion(transcription);

          // Check for silence after final result
          const currentTime = Date.now();
          if (marks.length > 0 && data?.length > 15) {
            console.log('Utterance detected (isFinal + silence)'.magenta);
            // ... perform actions like clearing the stream ...
            ws.send(
              JSON.stringify({
                
                streamSid,
                event: 'clear',
              }),
            );
          }
        }
      }

    });
    
    // Incoming from MediaStream
    ws.on('message', (data: string) => {
      const message: {
        event: string;
        start?: { streamSid: string; callSid: string };
        media?: { payload: string };
        mark?: { name: string };
        sequenceNumber?: number;
      } = JSON.parse(data);

      if (message.event === 'start' && message.start) {
        streamSid = message.start.streamSid;
        callSid = message.start.callSid;
        stream.setStreamSid(streamSid);
        llm.setCallSid(callSid);
        console.log(
          `Twilio -> Starting Media Stream for ${streamSid}`.underline.red,
        );
       
        textToSpeech.generate({
          partialResponseIndex: null,
          partialResponse: 'Hi, my name is Emma. How can I help you?',
        });

        // Estimate the duration of the greeting and unmute after it's likely finished
        
      } else if (message.event === 'media' && message.media) {
      
        
        if (marks.length === 0) {
          
          try {
              // Check if the stream is writable before writing
              if (recognizeStream.writable) {
                  recognizeStream.write(message.media.payload);
              } else {
                  console.error('Cannot write to stream: stream is not writable');
                  // Handle the situation where the stream is not writable 
                  // (e.g., create a new stream, inform the user, etc.)
              }
          } catch (error) {
              console.error('Error writing to recognizeStream:', error);
              // Handle the error appropriately 
              // (e.g., re-establish the connection, inform the user, etc.)
          }
      }

      } else if (message.event === 'mark' && message.mark) {
        const label: string = message.mark.name;

        console.log(
          `Twilio -> Audio completed mark (${message.sequenceNumber}): ${label}`
            .red,
        );

        marks = marks.filter((m: string) => m !== message.mark?.name);
      } else if (message.event === 'stop') {
        console.log(`Twilio -> Media stream ${streamSid} ended.`.underline.red);
      }
    });

    llm.on('llmreply', async (llmReply: { partialResponse: string }) => {
      console.log(`LLM -> TTS: ${llmReply.partialResponse}`.green);
      textToSpeech.generate(llmReply);
    });

    textToSpeech.on(
      'speech',
      (responseIndex: number, audio: string, label: string) => {
        console.log(`TTS -> TWILIO: ${label}`.blue);
  
        
        stream.buffer(responseIndex, audio);
  
        // Estimate the duration of the speech and reset the flag after it's likely finished
        // const estimatedDurationMs = audio.length / 16000; 
        // setTimeout(() => {
        //   isSpeaking = false;
        // }, estimatedDurationMs);
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
