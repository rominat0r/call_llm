import express, { Response } from 'express';
import ExpressWs from 'express-ws';
import { WebSocket } from 'ws';
import VoiceResponse from 'twilio/lib/twiml/VoiceResponse';
import { Llm } from './llm';
import { Stream } from './stream';
import { TextToSpeech } from './text-to-speech';
import * as path from 'path';
import * as fs from 'fs/promises';
import { isPromise } from 'util/types';
import { RealtimeTranscriber, AssemblyAI, RealtimeTranscript  } from 'assemblyai';

const app = ExpressWs(express()).app;
const PORT: number = parseInt(process.env.PORT || '8080');

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

    const client = new AssemblyAI({
      apiKey: `${process.env.ASSEMBLYAI_API_KEY}`,
    })
  
    const transcriber =  client.realtime.transcriber({
      
      // Twilio media stream sends audio in mulaw format
      encoding: 'pcm_mulaw',
      // Twilio media stream sends audio at 8000 sample rate
      sampleRate: 8000,
      endUtteranceSilenceThreshold: 1000,  
     
    })
    const transcriberConnectionPromise = transcriber.connect();
    
    // transcriber.on('transcript.partial', (partialTranscript) => {
    //   // Don't print anything when there's silence
    //   if (!partialTranscript.text) return;
    //   console.clear();
    //   console.log(partialTranscript.text);
    // });
    transcriber.on('transcript.final', (finalTranscript) => {
      
      //llm.completion(finalTranscript.text);  
      console.log(finalTranscript.text); 
    });

    transcriber.on('transcript', (transcript) => {
      
      console.log('Final:', transcript.words); 

    });

    
    // transcriber.on('transcript', (transcript: RealtimeTranscript) => {
    //   if (!transcript.text) {
    //     return
    //   }
  
    //   if (transcript.message_type === 'PartialTranscript') {
    //     console.log('Partial:', transcript.text)
    //   } else {
    //     console.log('Final:', transcript.text)
    //   }
    // })
    
    
    // Incoming from MediaStream

    ws.on('message', async (data: string) => {
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

        // const filePath = path.join(__dirname, 'test.m4a');

        // try {
        //   const audioBuffer = await fs.readFile(filePath);
        //   connection.send(audioBuffer);
        // } catch (err) {
        //   console.error('Error reading audio file:', err);
        // }

      } else if (message.event === 'media' && message.media) {
        
        await transcriberConnectionPromise;
        transcriber.sendAudio(Buffer.from(message.media.payload, 'base64'));
        
        
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
