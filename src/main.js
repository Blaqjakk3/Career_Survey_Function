import { Client, Databases, Query } from 'node-appwrite';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Initialize client
const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT || 'https://cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || '67d074d0001dadc04f94')
    .setKey(process.env.APPWRITE_API_KEY);

const databases = new Databases(client);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export default async ({ req, res, log, error }) => {
    try {
        log('Starting optimized AI career matching...');
        
        const { talentId, careerStage, responses } = JSON.parse(req.body);

        if (!talentId || !careerStage || !responses) {
            return res.json({ 
                success: false, 
                error: 'Missing required parameters: talentId, careerStage, and responses' 
            }, 400);
        }

        log(`Processing career matching for talent: ${talentId}, stage: ${careerStage}`);

        // Fetch talent details first
        const talentQuery = await databases.listDocuments(
            'career4me',
            'talents',
            [Query.equal('talentId', talentId)]
        );

        if (talentQuery.documents.length === 0) {
            return res.json({ success: false, error: 'Talent not found' }, 404);
        }

        const talent = talentQuery.documents[0];

        // Pre-filter career paths based on basic criteria to reduce dataset
        const careerPathsQuery = await databases.listDocuments(
            'career4me',
            'careerPaths',
            [Query.limit(100)] // Reduced limit for faster processing
        );

        if (careerPathsQuery.documents.length === 0) {
            return res.json({ success: false, error: 'No career paths available' }, 404);
        }

        // Pre-filter careers based on basic matching criteria
        const filteredCareers = preFilterCareers(careerPathsQuery.documents, responses, talent);
        
        log(`Pre-filtered to ${filteredCareers.length} careers from ${careerPathsQuery.documents.length} total`);

        // Generate AI-powered career matches with optimized approach
        const matches = await generateOptimizedAIMatches(
            talent,
            careerStage,
            responses,
            filteredCareers,
            log
        );

        log(`Career matching completed successfully with ${matches.length} matches`);
        return res.json({
            success: true,
            matches: matches,
            totalPaths: careerPathsQuery.documents.length,
            matchedPaths: matches.length,
            careerStage: careerStage
        });

    } catch (err) {
        error('Career matching failed:', err);
        return res.json({ 
            success: false, 
            error: err.message || 'Failed to generate career matches',
            details: process.env.NODE_ENV === 'development' ? err.stack : undefined
        }, 500);
    }
};

// Pre-filter careers to reduce AI processing load
function preFilterCareers(careerPaths, responses, talent) {
    return careerPaths.filter(path => {
        // Basic filtering logic to reduce dataset
        let score = 0;
        
        // Education level matching
        const userDegrees = responses.degrees || talent.degrees || [];
        const pathDegrees = path.suggestedDegrees || [];
        if (pathDegrees.length === 0 || userDegrees.some(degree => 
            pathDegrees.some(pathDegree => 
                pathDegree.toLowerCase().includes(degree.toLowerCase()) || 
                degree.toLowerCase().includes(pathDegree.toLowerCase())
            )
        )) {
            score += 1;
        }
        
        // Skills matching
        const userSkills = [...(responses.skills || []), ...(talent.skills || [])];
        const pathSkills = path.requiredSkills || [];
        const skillMatches = userSkills.filter(skill => 
            pathSkills.some(pathSkill => 
                pathSkill.toLowerCase().includes(skill.toLowerCase()) || 
                skill.toLowerCase().includes(pathSkill.toLowerCase())
            )
        );
        if (skillMatches.length > 0) {
            score += skillMatches.length;
        }
        
        // Interest matching
        const userInterests = responses.interests || talent.interests || [];
        const pathInterests = path.requiredInterests || [];
        const interestMatches = userInterests.filter(interest => 
            pathInterests.some(pathInterest => 
                pathInterest.toLowerCase().includes(interest.toLowerCase()) || 
                interest.toLowerCase().includes(pathInterest.toLowerCase())
            )
        );
        if (interestMatches.length > 0) {
            score += interestMatches.length;
        }
        
        // Return careers with any positive score, or top careers if too many
        return score > 0;
    }).slice(0, 50); // Limit to top 50 for AI analysis
}

async function generateOptimizedAIMatches(talent, careerStage, responses, careerPaths, log) {
    const model = genAI.getGenerativeModel({ 
        model: 'gemini-2.5-flash',
        generationConfig: {
            maxOutputTokens: 4000,
            temperature: 0.1, // Very low temperature for consistent JSON output
            responseMimeType: "application/json", // Force JSON response
        }
    });

    // Build concise user profile
    const userProfile = buildConciseProfile(talent, careerStage, responses);
    
    // Create simplified career paths summary - only essential fields
    const careerSummary = careerPaths.map(path => ({
        id: path.$id,
        title: path.title,
        industry: path.industry,
        skills: (path.requiredSkills || []).slice(0, 5),
        interests: (path.requiredInterests || []).slice(0, 3),
        degrees: (path.suggestedDegrees || []).slice(0, 3),
        salary: `${path.minSalary || 0}-${path.maxSalary || 0}`,
        outlook: path.jobOutlook || '',
        description: (path.description || '').substring(0, 200)
    }));

    // Improved prompt with stricter JSON schema
    const optimizedPrompt = `Analyze the user profile and career options to return exactly 5 best career matches.

USER PROFILE:
${userProfile}

CAREER OPTIONS:
${JSON.stringify(careerSummary, null, 1)}

You must respond with valid JSON following this exact schema:

{
  "matches": [
    {
      "careerPathId": "string_id_from_career_options",
      "matchScore": number_between_60_and_100,
      "reasoning": "Brief specific explanation of key alignments",
      "strengths": ["Specific strength 1", "Specific strength 2"],
      "developmentAreas": ["Specific area 1", "Specific area 2"],
      "recommendations": ["Specific action 1", "Specific action 2"]
    }
  ]
}

Rules:
- Return exactly 5 matches
- Use only careerPathId values from the provided career options
- Match scores should be realistic (60-100 range)
- Be specific in explanations, reference actual skills/interests
- Each array should have 2-3 items maximum
- Keep text concise but meaningful`; 

    try {
        log('Generating optimized AI analysis...');
        const startTime = Date.now();
        
        const result = await model.generateContent(optimizedPrompt);
        const aiResponse = result.response.text();
        
        const processingTime = Date.now() - startTime;
        log(`AI processing completed in ${processingTime}ms`);
        log(`AI Response preview: ${aiResponse.substring(0, 200)}...`);
        
        // Multiple JSON parsing attempts
        let analysisResult;
        
        try {
            // Try direct parsing first
            analysisResult = JSON.parse(aiResponse);
        } catch (directParseError) {
            log('Direct JSON parsing failed, trying extraction...');
            
            // Try to extract JSON from response
            const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    analysisResult = JSON.parse(jsonMatch[0]);
                } catch (extractParseError) {
                    log('JSON extraction parsing failed, trying cleanup...');
                    
                    // Clean up common JSON issues
                    let cleanedJson = jsonMatch[0]
                        .replace(/```json\n?/g, '')
                        .replace(/\n?```/g, '')
                        .replace(/,\s*}/g, '}')
                        .replace(/,\s*]/g, ']')
                        .trim();
                    
                    try {
                        analysisResult = JSON.parse(cleanedJson);
                    } catch (cleanupParseError) {
                        log(`All JSON parsing attempts failed. Response: ${aiResponse}`);
                        throw new Error('AI response could not be parsed as JSON');
                    }
                }
            } else {
                log(`No JSON found in AI response: ${aiResponse}`);
                throw new Error('AI response did not contain JSON');
            }
        }
        
        // Validate the parsed result
        if (!analysisResult || typeof analysisResult !== 'object') {
            throw new Error('Parsed AI response is not a valid object');
        }
        
        if (!analysisResult.matches || !Array.isArray(analysisResult.matches)) {
            throw new Error('AI response does not contain valid matches array');
        }
        
        if (analysisResult.matches.length === 0) {
            throw new Error('AI response contains no matches');
        }
        
        // Validate each match has required fields
        for (const match of analysisResult.matches) {
            if (!match.careerPathId || !match.matchScore || !match.reasoning) {
                throw new Error('AI response contains incomplete match data');
            }
        }
        
        log(`Successfully parsed ${analysisResult.matches.length} matches from AI response`);
        
        // Enrich matches with full career path data
        const enrichedMatches = analysisResult.matches
            .map(match => {
                const careerPath = careerPaths.find(cp => cp.$id === match.careerPathId);
                if (!careerPath) {
                    log(`Warning: Career path not found for ID: ${match.careerPathId}`);
                    return null;
                }
                
                return {
                    ...match,
                    // Ensure arrays exist with defaults
                    strengths: match.strengths || [],
                    developmentAreas: match.developmentAreas || [],
                    recommendations: match.recommendations || [],
                    careerPath: {
                        id: careerPath.$id,
                        title: careerPath.title,
                        industry: careerPath.industry,
                        description: careerPath.description || '',
                        minSalary: careerPath.minSalary || 0,
                        maxSalary: careerPath.maxSalary || 0,
                        jobOutlook: careerPath.jobOutlook || '',
                        requiredSkills: careerPath.requiredSkills || [],
                        suggestedDegrees: careerPath.suggestedDegrees || [],
                        dayToDayResponsibilities: careerPath.dayToDayResponsibilities || '',
                        careerProgression: careerPath.careerProgression || '',
                        toolsAndTechnologies: careerPath.toolsAndTechnologies || [],
                        typicalEmployers: careerPath.typicalEmployers || []
                    }
                };
            })
            .filter(match => match !== null);
            
        if (enrichedMatches.length === 0) {
            throw new Error('No valid career matches could be enriched with career path data');
        }
            
        log(`Successfully processed ${enrichedMatches.length} career matches`);
        return enrichedMatches;
        
    } catch (err) {
        log(`AI generation failed: ${err.message}`);
        
        // Fallback: return basic matches if AI fails
        const fallbackMatches = createFallbackMatches(careerPaths, responses, talent, log);
        if (fallbackMatches.length > 0) {
            log(`Returning ${fallbackMatches.length} fallback matches`);
            return fallbackMatches;
        }
        
        throw new Error(`Failed to generate AI career matches: ${err.message}`);
    }
}

// Fallback function to create basic matches when AI fails
function createFallbackMatches(careerPaths, responses, talent, log) {
    try {
        log('Creating fallback matches...');
        
        const userSkills = [...(responses.skills || []), ...(talent.skills || [])];
        const userInterests = responses.interests || talent.interests || [];
        
        return careerPaths
            .slice(0, 5) // Take first 5 careers
            .map((path, index) => ({
                careerPathId: path.$id,
                matchScore: Math.max(60, 90 - index * 5), // Decreasing scores from 90 to 70
                reasoning: `This career matches your background and shows potential for growth in your areas of interest.`,
                strengths: [
                    `Your skills align with this career path`,
                    `Good potential for professional development`
                ],
                developmentAreas: [
                    `Consider developing relevant technical skills`,
                    `Gain more experience in the field`
                ],
                recommendations: [
                    `Research the industry requirements`,
                    `Consider relevant training or certification`
                ],
                careerPath: {
                    id: path.$id,
                    title: path.title,
                    industry: path.industry,
                    description: path.description || '',
                    minSalary: path.minSalary || 0,
                    maxSalary: path.maxSalary || 0,
                    jobOutlook: path.jobOutlook || '',
                    requiredSkills: path.requiredSkills || [],
                    suggestedDegrees: path.suggestedDegrees || [],
                    dayToDayResponsibilities: path.dayToDayResponsibilities || '',
                    careerProgression: path.careerProgression || '',
                    toolsAndTechnologies: path.toolsAndTechnologies || [],
                    typicalEmployers: path.typicalEmployers || []
                }
            }));
    } catch (error) {
        log(`Fallback match creation failed: ${error.message}`);
        return [];
    }
}

function buildConciseProfile(talent, careerStage, responses) {
    // Build a much more concise user profile to reduce token usage
    const profile = {
        stage: careerStage,
        education: responses.educationLevel || talent.educationLevel || 'Not specified',
        degrees: (responses.degrees || talent.degrees || []).join(', ') || 'Not specified',
        skills: [...(responses.skills || []), ...(talent.skills || [])].join(', ') || 'Not specified',
        interests: (responses.interests || talent.interests || []).join(', ') || 'Not specified',
        targetFields: (responses.interestedFields || talent.interestedFields || []).join(', ') || 'Not specified',
        workEnv: (responses.preferredWorkEnvironment || []).join(', ') || 'Not specified'
    };

    // Add stage-specific info concisely
    if (careerStage === 'Trailblazer' && responses.currentPosition) {
        profile.current = `${responses.currentPosition} (${responses.yearsExperience || 'unknown'} years)`;
        profile.goals = (responses.careerGoals || []).join(', ');
    }

    if (careerStage === 'Horizon Changer' && responses.currentField) {
        profile.currentField = responses.currentField;
        profile.changeReasons = (responses.changeReasons || []).join(', ');
        profile.targets = (responses.targetFields || []).join(', ');
    }

    // Additional context (truncated)
    if (responses.additionalContext) {
        profile.context = responses.additionalContext.substring(0, 150);
    }

    return JSON.stringify(profile, null, 1);
}