import express, { Response } from 'express';
import ExpressWs from 'express-ws';
import { WebSocket } from 'ws';
import VoiceResponse from 'twilio/lib/twiml/VoiceResponse';
import { Llm } from './llm';
import { Stream } from './stream';
import { TextToSpeech } from './text-to-speech';
import * as path from 'path';

import { isPromise } from 'util/types';
import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import fs from 'fs';

const app = ExpressWs(express()).app;
const PORT: number = parseInt(process.env.PORT || '8080');

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);

const playSound = (): string => {
  const filePath = path.join(__dirname, 'sound.mp3'); // Use PCM file
  const buffer = fs.readFileSync(filePath);
  return buffer.toString('base64'); // Convert buffer to base64
};
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
    let isAssistantSpeaking = false;
    console.log('Twilio -> Connection opened'.underline.green);

    ws.on('error', console.error);

    const llm = new Llm();
    const stream = new Stream(ws);
    const textToSpeech = new TextToSpeech();

    let streamSid: string;
    let callSid: string;
    let marks: string[] = [];
    let keepAlive;
    let is_finals: any = [];

    const connection = deepgram.listen.live({

      smart_format: true,
      model: 'nova-2-phonecall',
      language: 'en-US',
      encoding: 'mulaw',
      sample_rate: 8000,
      diarize: true,
      interim_results: true,
      utterance_end_ms: 1000,
      vad_events: true,
      endpointing: 300,
    });

    if (keepAlive) clearInterval(keepAlive);
    keepAlive = setInterval(() => {
      connection.keepAlive();
    }, 3000);


    connection.on(LiveTranscriptionEvents.Open, () => {

      // Listen for any transcripts received from Deepgram and write them to the console.
      connection.on(LiveTranscriptionEvents.Transcript, (data) => {
        if (isAssistantSpeaking) return;
        const speakers = data.channel.alternatives[0].words?.map((word: { speaker: number }) => word.speaker);

        // if (isAssistantSpeaking){
        //   if ( speakers.includes(1) )
        //         {
        //          console.log('Utterance detected (isFinal + silence)'.magenta);
        //          console.dir(data.channel.alternatives[0]);
        //          // ... perform actions like clearing the stream ...
        //          ws.send(
        //            JSON.stringify({
        //              streamSid,
        //              event: 'clear',
        //            }),
        //          );
        //        }
        //        else{
        //         return;
        //        }
        // }

        const sentence = data.channel.alternatives[0].transcript;
        // Ignore empty transcripts
        if (sentence.length == 0) {
          return;
        }

        if (data.is_final) {
          // We need to collect these and concatenate them together when we get a speech_final=true
          // See docs: https://developers.deepgram.com/docs/understand-endpointing-interim-results
          is_finals.push(sentence);

          // Speech final means we have detected sufficent silence to consider this end of speech
          // Speech final is the lowest latency result as it triggers as soon an the endpointing value has triggered
          if (data.speech_final) {

            const utterance = is_finals.join(" ");

            if (!isAssistantSpeaking) {
              if (utterance.length > 0) llm.completion(utterance);
            }

            console.log(`User: ${utterance}`.yellow);
            console.log(speakers);
            is_finals = [];

          }
        }
      });

      connection.on(LiveTranscriptionEvents.UtteranceEnd, (data) => {
        const utterance = is_finals.join(" ");
        // console.log(`Deepgram UtteranceEnd: ${utterance}`);


        is_finals = [];
      });

      connection.on(LiveTranscriptionEvents.Close, () => {
        console.log("Connection closed.");
      });

      // Listen for the connection to close.

    });

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
          partialResponse: 'Slava Ukraiini! My name is Emma. How can I help you?',
        });



      } else if (message.event === 'media' && message.media) {

        const audioBuffer = Buffer.from(message.media.payload, 'base64');
        connection.send(audioBuffer);

      } else if (message.event === 'mark' && message.mark) {

        const label: string = message.mark.name;

        // console.log(
        //   `Twilio -> Audio completed mark (${message.sequenceNumber}): ${label}`
        //     .red,
        // );


        marks = marks.filter((m: string) => m !== message.mark?.name);
      } else if (message.event === 'stop') {
        console.log(`Twilio -> Media stream ${streamSid} ended.`.underline.red);
        isAssistantSpeaking = false;
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

        const estimatedDurationMs = audio.length / 5.3;
        console.log(`Estimated duration: ${estimatedDurationMs}ms`);
        setTimeout( () => {
          isAssistantSpeaking = false;
          //const sound = playSound();
          //play sound 
          //stream.buffer(responseIndex, sound);
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
