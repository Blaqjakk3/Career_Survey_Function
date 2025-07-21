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
        log('Starting AI career matching...');
        
        const { talentId, careerStage, responses } = JSON.parse(req.body);

        if (!talentId || !careerStage || !responses) {
            return res.json({ 
                success: false, 
                error: 'Missing required parameters: talentId, careerStage, and responses' 
            }, 400);
        }

        log(`Processing career matching for talent: ${talentId}, stage: ${careerStage}`);

        // Fetch all available career paths
        const careerPathsQuery = await databases.listDocuments(
            'career4me',
            'careerPaths',
            [Query.limit(200)] // Increased limit to get more career paths
        );

        if (careerPathsQuery.documents.length === 0) {
            return res.json({ success: false, error: 'No career paths available' }, 404);
        }

        // Fetch talent details
        const talentQuery = await databases.listDocuments(
            'career4me',
            'talents',
            [Query.equal('talentId', talentId)]
        );

        if (talentQuery.documents.length === 0) {
            return res.json({ success: false, error: 'Talent not found' }, 404);
        }

        const talent = talentQuery.documents[0];

        // Get current career path details if available (for Trailblazer and Horizon Changer)
        let currentCareerPath = null;
        if (responses.currentPath) {
            try {
                currentCareerPath = await databases.getDocument(
                    'career4me',
                    'careerPaths',
                    responses.currentPath
                );
            } catch (err) {
                log(`Warning: Could not fetch current career path: ${responses.currentPath}`);
            }
        }

        // Generate AI-powered career matches
        const matches = await generateAICareerMatches(
            talent,
            careerStage,
            responses,
            careerPathsQuery.documents,
            currentCareerPath,
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

async function generateAICareerMatches(talent, careerStage, responses, careerPaths, currentCareerPath, log) {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    // Build comprehensive context for AI analysis
    const contextPrompt = buildContextPrompt(talent, careerStage, responses, currentCareerPath);
    
    // Create career paths summary for AI - include all relevant fields
    const careerPathsSummary = careerPaths.map(path => ({
        id: path.$id,
        title: path.title,
        industry: path.industry,
        requiredSkills: path.requiredSkills || [],
        requiredInterests: path.requiredInterests || [],
        requiredCertifications: path.requiredCertifications || [],
        suggestedDegrees: path.suggestedDegrees || [],
        description: path.description || '',
        minSalary: path.minSalary || 0,
        maxSalary: path.maxSalary || 0,
        jobOutlook: path.jobOutlook || '',
        dayToDayResponsibilities: path.dayToDayResponsibilities || '',
        toolsAndTechnologies: path.toolsAndTechnologies || [],
        careerProgression: path.careerProgression || '',
        typicalEmployers: path.typicalEmployers || [],
        required_background: path.required_background || '',
        time_to_complete: path.time_to_complete || '',
        learning_style: path.learning_style || '',
        tags: path.tags || []
    }));

    const analysisPrompt = `${contextPrompt}

AVAILABLE CAREER PATHS:
${JSON.stringify(careerPathsSummary, null, 2)}

ANALYSIS REQUIREMENTS:
You are a professional career counselor providing personalized career guidance. Analyze the user's complete profile against all available career paths and provide detailed, actionable recommendations.

KEY ANALYSIS FACTORS:
1. **Skills Alignment**: Match current skills and learning interests with required skills
2. **Education Compatibility**: Consider current education level and degree programs
3. **Interest Matching**: Align personal interests with career requirements and daily responsibilities
4. **Growth Potential**: Consider career progression opportunities and job outlook
5. **Work Environment Fit**: Match preferred work environments with typical career settings
6. **Entry Requirements**: Assess feasibility based on current background and required prerequisites
7. **Learning Path**: Consider time to complete and required background for career entry

CAREER STAGE SPECIFIC CONSIDERATIONS:
- **Pathfinder**: Focus on entry-level opportunities, learning potential, foundational skill building, and paths that match educational level
- **Trailblazer**: Emphasize career advancement, skill building, leadership opportunities, and progression from current role
- **Horizon Changer**: Highlight transferable skills, transition feasibility, retraining requirements, and motivation alignment

MATCHING CRITERIA:
- Use information from BOTH the career paths database AND your knowledge of careers to provide comprehensive analysis
- Consider industry trends, job market conditions, and emerging opportunities
- Factor in salary expectations, work-life balance, and growth trajectory
- Assess both immediate opportunities and long-term career development

RESPONSE FORMAT:
Return EXACTLY 5 career matches in this JSON format (NO additional text outside the JSON):

{
  "matches": [
    {
      "careerPathId": "exact_path_id_from_database",
      "matchScore": 85,
      "reasoning": "Your background in [specific area] makes you an excellent fit for this role because [detailed explanation]. Your interest in [specific interest] aligns perfectly with the daily responsibilities which include [specific examples]. The role requires [specific skills] which you either possess or have shown interest in developing.",
      "strengths": [
        "You already have experience with [specific skill/area]",
        "Your educational background in [field] provides a solid foundation",
        "Your interest in [area] directly supports the core responsibilities"
      ],
      "developmentAreas": [
        "You should focus on developing [specific technical skill] through [specific suggestion]",
        "Consider gaining experience in [specific area] by [actionable step]",
        "You could strengthen your background in [area] by [specific recommendation]"
      ],
      "recommendations": [
        "Start by taking [specific course/certification] to build foundational knowledge",
        "Consider seeking internships or projects in [specific area] to gain practical experience",
        "Network with professionals in [industry] through [specific platforms/events]",
        "Build a portfolio showcasing [specific skills] by [specific projects]"
      ]
    }
  ]
}

IMPORTANT GUIDELINES:
- ALL text must speak directly to the user using "you", "your", "you have", "you should", etc.
- Be specific and actionable in all recommendations
- Reference actual skills, interests, and background from the user's profile
- Match careerPathId exactly with the database IDs provided
- Provide realistic timelines and expectations
- Consider both immediate opportunities and growth potential
- Include specific tools, technologies, or certifications mentioned in career paths
- Factor in salary ranges and job outlook information where relevant

Generate realistic, well-reasoned matches that consider the user's complete profile and career stage.`; 

    try {
        log('Generating AI analysis with Gemini 2.5 Flash...');
        const result = await model.generateContent(analysisPrompt);
        const aiResponse = result.response.text();
        
        log('AI Response received, parsing JSON...');
        
        // Extract JSON from AI response
        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            log('No valid JSON found in AI response');
            throw new Error('AI response did not contain valid JSON');
        }
        
        const analysisResult = JSON.parse(jsonMatch[0]);
        
        if (!analysisResult.matches || !Array.isArray(analysisResult.matches)) {
            log('Invalid matches structure in AI response');
            throw new Error('AI response contains invalid matches structure');
        }
        
        // Enrich matches with full career path data and validate
        const enrichedMatches = analysisResult.matches
            .map(match => {
                const careerPath = careerPaths.find(cp => cp.$id === match.careerPathId);
                if (!careerPath) {
                    log(`Warning: Career path not found for ID: ${match.careerPathId}`);
                    return null;
                }
                
                return {
                    ...match,
                    careerPath: {
                        id: careerPath.$id,
                        title: careerPath.title,
                        industry: careerPath.industry,
                        description: careerPath.description,
                        minSalary: careerPath.minSalary,
                        maxSalary: careerPath.maxSalary,
                        jobOutlook: careerPath.jobOutlook,
                        requiredSkills: careerPath.requiredSkills || [],
                        suggestedDegrees: careerPath.suggestedDegrees || [],
                        dayToDayResponsibilities: careerPath.dayToDayResponsibilities,
                        careerProgression: careerPath.careerProgression,
                        toolsAndTechnologies: careerPath.toolsAndTechnologies || [],
                        typicalEmployers: careerPath.typicalEmployers || []
                    }
                };
            })
            .filter(match => match !== null);
            
        log(`Successfully processed ${enrichedMatches.length} career matches`);
        return enrichedMatches;
        
    } catch (err) {
        log(`AI generation failed: ${err.message}`);
        throw new Error(`Failed to generate AI career matches: ${err.message}`);
    }
}

function buildContextPrompt(talent, careerStage, responses, currentCareerPath) {
    let context = `TALENT PROFILE ANALYSIS:

CAREER STAGE: ${careerStage}
TALENT ID: ${talent.talentId}

PERSONAL INFORMATION:
- Name: ${talent.name || 'Not provided'}
- Email: ${talent.email || 'Not provided'}
- Phone: ${talent.phoneNumber || 'Not provided'}
- Age: ${talent.age || 'Not provided'}
- Location: ${talent.location || 'Not provided'}
- Gender: ${talent.gender || 'Not provided'}

EDUCATION & BACKGROUND:
- Education Level: ${responses.educationLevel || talent.educationLevel || 'Not provided'}
- Degree(s): ${responses.degrees ? responses.degrees.join(', ') : (talent.degrees || 'Not provided')}
- Previous Experience: ${talent.experience || 'Not provided'}

SKILLS PROFILE:
- Current Skills: ${responses.skills ? responses.skills.join(', ') : (talent.skills || 'Not provided')}
- Skills of Interest: ${responses.interestedSkills ? responses.interestedSkills.join(', ') : 'Not provided'}

INTERESTS & PREFERENCES:
- Main Interests: ${responses.interests ? responses.interests.join(', ') : (talent.interests || 'Not provided')}
- Fields of Interest: ${responses.interestedFields ? responses.interestedFields.join(', ') : (talent.interestedFields || 'Not provided')}
- Preferred Work Environment: ${responses.preferredWorkEnvironment ? responses.preferredWorkEnvironment.join(', ') : 'Not provided'}

ADDITIONAL CONTEXT:
${responses.additionalContext || 'No additional context provided'}`;

    // Add career stage specific information
    if (careerStage === 'Trailblazer' && responses.currentPosition) {
        context += `\n\nCURRENT CAREER STATUS:
- Current Position: ${responses.currentPosition}
- Years of Experience: ${responses.yearsExperience || 'Not provided'}
- Seniority Level: ${responses.seniorityLevel || 'Not provided'}
- Career Goals: ${responses.careerGoals ? responses.careerGoals.join(', ') : 'Not provided'}`;
    }

    if (careerStage === 'Horizon Changer' && responses.currentField) {
        context += `\n\nCAREER CHANGE CONTEXT:
- Current Field: ${responses.currentField}
- Reasons for Change: ${responses.changeReasons ? responses.changeReasons.join(', ') : 'Not provided'}
- Change Urgency: ${responses.changeUrgency || 'Not provided'}
- Willing to Retrain: ${responses.willingToRetrain || 'Not provided'}`;
    }

    if (currentCareerPath) {
        context += `\n\nCURRENT CAREER PATH DETAILS:
- Title: ${currentCareerPath.title}
- Industry: ${currentCareerPath.industry}
- Description: ${currentCareerPath.description || 'Not provided'}`;
    }

    return context;
}